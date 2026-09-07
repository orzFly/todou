import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type {
  CrossChangeEvent,
  InboxRowState,
  IssueListFilter,
  IssueListRow,
  MeEvent,
} from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issuesEntry } from "../src/api/issues-cache.ts";
import { clientOrigin } from "../src/api/queries.ts";
import { openTabChannel, type TabMessage } from "../src/api/tab-sync.ts";
import {
  cachedIssueRow,
  coalesceBatch,
  INVALIDATE_COALESCE_MS,
  inboxAttentionDiffers,
  inboxInvalidations,
  inboxRowContentDiffers,
  inboxRowIn,
  invalidationsFor,
  isSharedKey,
  meInvalidations,
  pageContainsIssue,
  pageHasUnreadRow,
  RECONNECT_BASE_MS,
  reconnectInvalidations,
  SHARED_QUERY_KEYS,
  STALL_TIMEOUT_MS,
  shouldAdopt,
  useUserEvents,
} from "../src/api/useUserEvents.ts";
import { installTabSync } from "./tab-sync.ts";

const AT = "2026-09-07T10:00:00.000Z";
const LATER = "2026-09-07T11:00:00.000Z";

/** The account whose stream every tab in here shares (T-276). */
const USER_ID = 42;

/** The server's fingerprint of one inbox row. */
const fingerprint = (over: Partial<InboxRowState> = {}): InboxRowState => ({
  updated_at: AT,
  unread: true,
  unread_comments: 2,
  pending_spec_review: false,
  open_questions: 0,
  ...over,
});

/** The same row as a client would have it cached, from /me/inbox. */
const cachedRow = (over: Record<string, unknown> = {}) => ({
  number: 7,
  project: { slug: "todou", name: "Todou" },
  ...fingerprint(),
  ...over,
});

const cachedInbox = (...items: Record<string, unknown>[]) => ({
  items,
  truncated: false,
});

describe("invalidationsFor (SSE → invalidation descriptors)", () => {
  it("falls back to a broad refetch for an unjudged issue event", () => {
    // No `list_row`: a server predating T-279, or a publish path nobody
    // annotated. The only safe reading is the one that existed before the
    // field did.
    expect(
      invalidationsFor(
        { entity: "issue", id: 1, action: "updated", issue_number: 42 },
        "todou",
      ),
    ).toEqual([
      { key: ["issues", "todou"], scope: "refetch" },
      { key: ["issue", "todou", 42], scope: "refetch" },
      { key: ["timeline", "todou", 42], scope: "refetch" },
    ]);
  });

  it("turns each list_row kind into its verdict (T-279)", () => {
    const listScope = (row: IssueListRow) =>
      invalidationsFor(
        {
          entity: "issue",
          id: 1,
          action: "updated",
          issue_number: 42,
          list_row: row,
        },
        "todou",
      ).find(
        (inv) =>
          JSON.stringify(inv.key) === JSON.stringify(["issues", "todou"]),
      )?.scope;

    expect(listScope({ kind: "activity" })).toEqual({
      issueRows: [{ verdict: "activity", number: 42 }],
    });
    expect(listScope({ kind: "gone" })).toEqual({
      issueRows: [{ verdict: "gone", number: 42 }],
    });
    const fields: IssueListRow = {
      kind: "fields",
      status_id: 3,
      label_ids: [7],
    };
    expect(listScope(fields)).toEqual({
      issueRows: [{ verdict: "fields", number: 42, row: fields }],
    });
  });

  it("leaves the lists to the paired issue event on a spec change", () => {
    // Every spec write emits an `issue` event too, and its `activity`
    // verdict refreshes exactly the pages showing the badge — so a second,
    // broad pass on the same key would only undo that narrowing.
    expect(
      invalidationsFor(
        { entity: "spec", id: 1, action: "updated", issue_number: 42 },
        "todou",
      ).map((inv) => inv.key),
    ).toEqual([
      ["spec", "todou", 42],
      ["spec-files", "todou", 42, "current"],
      ["issue", "todou", 42],
    ]);
  });

  it("scopes timeline events' list refetch to pages containing the issue", () => {
    expect(
      invalidationsFor(
        { entity: "timeline", id: 5, action: "created", issue_number: 7 },
        "todou",
      ),
    ).toEqual([
      { key: ["timeline", "todou", 7], scope: "refetch" },
      { key: ["questions", "todou", 7], scope: "refetch" },
      // Unread markers (T-46) ride the list payload. An unpaired timeline
      // entry (`referenced`, a comment edit) does not bump updated_at
      // (T-101), so it cannot move a row between pages.
      {
        key: ["issues", "todou"],
        scope: { issueRows: [{ verdict: "contains", number: 7 }] },
      },
    ]);
  });

  it("maps config entities to their lists plus issues", () => {
    expect(
      invalidationsFor({ entity: "status", id: 1, action: "updated" }, "p"),
    ).toEqual([
      { key: ["statuses", "p"], scope: "refetch" },
      { key: ["issues", "p"], scope: "refetch" },
    ]);
    // A member event can be the user's own grant or revocation, so the
    // project list goes stale with it (T-122) — as does the agent Projects
    // column, whose rows are memberships of exactly this kind (T-227).
    expect(
      invalidationsFor({ entity: "member", id: 1, action: "deleted" }, "p"),
    ).toEqual([
      { key: ["members", "p"], scope: "refetch" },
      { key: ["projects"], scope: "refetch" },
      { key: ["agent-memberships"], scope: "refetch" },
    ]);
  });

  it("covers reconnect compensation broadly, inbox included", () => {
    const keys = reconnectInvalidations();
    expect(keys.length).toBeGreaterThanOrEqual(6);
    expect(keys).toContainEqual(["inbox"]);
    // Slug-less prefixes: the user-level stream spans every project, so
    // the compensation must too.
    expect(keys).toContainEqual(["issues"]);
    expect(keys).toContainEqual(["projects"]);
    // A preference toggled elsewhere during the outage has no other way in:
    // its `me` event went down with the connection (T-275).
    expect(keys).toContainEqual(["me-prefs"]);
  });
});

describe("inboxInvalidations (T-112, T-275)", () => {
  const event = (over: Partial<CrossChangeEvent> = {}): CrossChangeEvent => ({
    entity: "comment",
    id: 1,
    action: "created",
    issue_number: 7,
    project: "todou",
    ...over,
  });

  it("stays out of the way for entities the inbox cannot show", () => {
    for (const entity of ["label", "member", "project", "status"] as const) {
      expect(inboxInvalidations(event({ entity }))).toEqual([]);
    }
  });

  it("refetches whenever the server did not judge the event", () => {
    // No `inbox_row` field: a server predating T-275, a subscription that
    // did not opt in, a judgement that failed, or a flood. All the same.
    for (const entity of ["issue", "comment", "timeline", "spec"] as const) {
      expect(inboxInvalidations(event({ entity }))).toEqual([
        { key: ["inbox"], scope: "refetch" },
      ]);
    }
  });

  it("compares the described row against the cache, either way", () => {
    const row = fingerprint();
    expect(inboxInvalidations(event({ inbox_row: row }))).toEqual([
      {
        key: ["inbox"],
        scope: { inboxRows: [{ project: "todou", number: 7, row }] },
      },
    ]);
    expect(inboxInvalidations(event({ inbox_row: null }))).toEqual([
      {
        key: ["inbox"],
        scope: { inboxRows: [{ project: "todou", number: 7, row: null }] },
      },
    ]);
  });

  it("refetches a judged event that names no issue", () => {
    // The server never sends this pair, and if one ever arrives there is
    // no row to compare against — so fall back to the safe, slow answer.
    expect(
      inboxInvalidations(
        event({ entity: "issue", issue_number: undefined, inbox_row: null }),
      ),
    ).toEqual([{ key: ["inbox"], scope: "refetch" }]);
  });
});

describe("meInvalidations (T-275)", () => {
  it("compares the row and narrows the list for a single mark-read", () => {
    const row = fingerprint({ unread: false, unread_comments: 0 });
    const event: MeEvent = {
      kind: "issue_read",
      project: "todou",
      issue_number: 7,
      inbox_row: row,
    };
    expect(meInvalidations(event)).toEqual([
      {
        key: ["inbox"],
        scope: { inboxRows: [{ project: "todou", number: 7, row }] },
      },
      {
        key: ["issues", "todou"],
        scope: { issueRows: [{ verdict: "read", number: 7 }] },
      },
    ]);
  });

  it("broadcasts a sweep, per project or across all of them", () => {
    expect(
      meInvalidations({ kind: "reads_swept", projects: ["a", "b"] }),
    ).toEqual([
      { key: ["inbox"], scope: "refetch" },
      { key: ["issues", "a"], scope: "refetch" },
      { key: ["issues", "b"], scope: "refetch" },
    ]);
    expect(meInvalidations({ kind: "reads_swept" })).toEqual([
      { key: ["inbox"], scope: "refetch" },
      { key: ["issues"], scope: "refetch" },
    ]);
  });

  it("refetches the inbox and the preferences on a preference change", () => {
    expect(meInvalidations({ kind: "prefs" })).toEqual([
      { key: ["inbox"], scope: "refetch" },
      { key: ["me-prefs"], scope: "refetch" },
    ]);
  });
});

describe("coalesceBatch (T-275)", () => {
  const verdict = (number: number) => ({
    project: "todou",
    number,
    row: fingerprint(),
  });
  const listVerdict = (number: number) =>
    ({ verdict: "contains", number }) as const;

  it("merges every inbox verdict on the key into one descriptor", () => {
    // The measured problem: invalidateQueries cancels and restarts an
    // in-flight refetch, so N descriptors on ["inbox"] cost N requests.
    expect(
      coalesceBatch([
        { key: ["inbox"], scope: { inboxRows: [verdict(1)] } },
        { key: ["inbox"], scope: { inboxRows: [verdict(2)] } },
        { key: ["inbox"], scope: { inboxRows: [verdict(3)] } },
      ]),
    ).toEqual([
      {
        key: ["inbox"],
        scope: { inboxRows: [verdict(1), verdict(2), verdict(3)] },
      },
    ]);
  });

  it("merges list verdicts on one key, per project (T-279)", () => {
    // The board case: nine columns, one merged descriptor, so a burst asks
    // each column at most once however long it runs.
    expect(
      coalesceBatch([
        { key: ["issues", "todou"], scope: { issueRows: [listVerdict(1)] } },
        { key: ["issues", "todou"], scope: { issueRows: [listVerdict(2)] } },
        { key: ["issues", "other"], scope: { issueRows: [listVerdict(3)] } },
      ]),
    ).toEqual([
      {
        key: ["issues", "todou"],
        scope: { issueRows: [listVerdict(1), listVerdict(2)] },
      },
      { key: ["issues", "other"], scope: { issueRows: [listVerdict(3)] } },
    ]);
  });

  it("merges verdicts of different kinds into the same descriptor", () => {
    // A comment and its paired issue event land in one window, and the merged
    // predicate ORs them — which is why they may share a descriptor.
    expect(
      coalesceBatch([
        { key: ["issues", "todou"], scope: { issueRows: [listVerdict(1)] } },
        {
          key: ["issues", "todou"],
          scope: { issueRows: [{ verdict: "activity", number: 1 }] },
        },
      ]),
    ).toEqual([
      {
        key: ["issues", "todou"],
        scope: {
          issueRows: [listVerdict(1), { verdict: "activity", number: 1 }],
        },
      },
    ]);
  });

  it("lets a broad refetch subsume the narrower scopes on its key", () => {
    expect(
      coalesceBatch([
        { key: ["inbox"], scope: { inboxRows: [verdict(1)] } },
        { key: ["inbox"], scope: "refetch" },
        { key: ["issues", "todou"], scope: { issueRows: [listVerdict(4)] } },
      ]),
    ).toEqual([
      { key: ["inbox"], scope: "refetch" },
      { key: ["issues", "todou"], scope: { issueRows: [listVerdict(4)] } },
    ]);
  });

  it("collapses identical descriptors", () => {
    expect(
      coalesceBatch([
        { key: ["timeline", "todou", 3], scope: "refetch" },
        { key: ["timeline", "todou", 3], scope: "refetch" },
        { key: ["issues", "todou"], scope: { issueRows: [listVerdict(3)] } },
        { key: ["issues", "todou"], scope: { issueRows: [listVerdict(3)] } },
      ]),
    ).toEqual([
      { key: ["timeline", "todou", 3], scope: "refetch" },
      { key: ["issues", "todou"], scope: { issueRows: [listVerdict(3)] } },
    ]);
  });

  it("does not write through to the descriptors it was given", () => {
    const one: ReturnType<typeof coalesceBatch>[number] = {
      key: ["inbox"],
      scope: { inboxRows: [verdict(1)] },
    };
    coalesceBatch([
      one,
      { key: ["inbox"], scope: { inboxRows: [verdict(2)] } },
    ]);
    expect(one.scope).toEqual({ inboxRows: [verdict(1)] });
  });
});

describe("inboxRowIn", () => {
  const page = cachedInbox(cachedRow());

  it("finds the row by project and number", () => {
    expect(inboxRowIn(page, "todou", 7)).toMatchObject({ number: 7 });
  });

  it("misses the same number in another project", () => {
    expect(inboxRowIn(page, "other", 7)).toBeUndefined();
  });

  it("misses another number in the same project", () => {
    expect(inboxRowIn(page, "todou", 8)).toBeUndefined();
  });

  it("tolerates empty caches", () => {
    expect(inboxRowIn(undefined, "todou", 7)).toBeUndefined();
  });

  it("rejects anything that is not a list of rows", () => {
    expect(inboxRowIn({ count: 3 }, "todou", 7)).toBeUndefined();
    expect(inboxRowIn({ items: [{ number: 7 }] }, "todou", 7)).toBeUndefined();
  });
});

describe("inboxAttentionDiffers / inboxRowContentDiffers", () => {
  const held = cachedInbox(cachedRow());
  const empty = cachedInbox();

  it("says nothing changed when the row is absent on both sides", () => {
    expect(inboxAttentionDiffers(empty, "todou", 7, null)).toBe(false);
    expect(inboxRowContentDiffers(empty, "todou", 7, null)).toBe(false);
  });

  it("wants a refetch when the row has to leave the cache", () => {
    expect(inboxAttentionDiffers(held, "todou", 7, null)).toBe(true);
    expect(inboxRowContentDiffers(held, "todou", 7, null)).toBe(false);
  });

  it("wants a refetch when the row has to arrive", () => {
    expect(inboxAttentionDiffers(empty, "todou", 7, fingerprint())).toBe(true);
  });

  it("wants a refetch on any of the four attention fields", () => {
    for (const over of [
      { unread: false },
      { unread_comments: 3 },
      { pending_spec_review: true },
      { open_questions: 1 },
    ]) {
      expect(inboxAttentionDiffers(held, "todou", 7, fingerprint(over))).toBe(
        true,
      );
    }
  });

  it("only marks stale when the card's content moved", () => {
    const row = fingerprint({ updated_at: LATER });
    expect(inboxAttentionDiffers(held, "todou", 7, row)).toBe(false);
    expect(inboxRowContentDiffers(held, "todou", 7, row)).toBe(true);
  });

  it("does neither when every field agrees", () => {
    expect(inboxAttentionDiffers(held, "todou", 7, fingerprint())).toBe(false);
    expect(inboxRowContentDiffers(held, "todou", 7, fingerprint())).toBe(false);
  });

  it("never asks for both at once", () => {
    // A row whose attention fields moved is refetched, so marking it stale
    // as well would refetch it twice.
    const row = fingerprint({ unread_comments: 9, updated_at: LATER });
    expect(inboxAttentionDiffers(held, "todou", 7, row)).toBe(true);
    expect(inboxRowContentDiffers(held, "todou", 7, row)).toBe(false);
  });
});

describe("pageHasUnreadRow", () => {
  it("finds a row that still shows unread", () => {
    expect(pageHasUnreadRow({ items: [{ number: 7, unread: true }] }, 7)).toBe(
      true,
    );
    expect(
      pageHasUnreadRow(
        { items: [{ number: 7, unread: false, unread_comments: 2 }] },
        7,
      ),
    ).toBe(true);
  });

  it("passes over a row whose unread state is already clear", () => {
    expect(
      pageHasUnreadRow(
        { items: [{ number: 7, unread: false, unread_comments: 0 }] },
        7,
      ),
    ).toBe(false);
  });

  it("passes over pages without the row, and non-list shapes", () => {
    expect(pageHasUnreadRow({ items: [{ number: 8, unread: true }] }, 7)).toBe(
      false,
    );
    expect(pageHasUnreadRow({ open: 3, closed: 4 }, 7)).toBe(false);
    expect(pageHasUnreadRow(undefined, 7)).toBe(false);
  });
});

describe("pageContainsIssue", () => {
  it("finds the row in a list page", () => {
    expect(pageContainsIssue({ items: [{ number: 7 }] }, 7)).toBe(true);
  });

  it("misses pages without the row", () => {
    expect(pageContainsIssue({ items: [{ number: 8 }] }, 7)).toBe(false);
  });

  it("rejects the counts shape (no items)", () => {
    expect(pageContainsIssue({ open: 3, closed: 4 }, 7)).toBe(false);
  });

  it("tolerates empty caches", () => {
    expect(pageContainsIssue(undefined, 7)).toBe(false);
  });
});

type Listener = (e: MessageEvent) => void;

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  url: string;
  readyState = MockEventSource.CONNECTING;
  listeners = new Map<string, Listener[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
}

describe("useUserEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    MockEventSource.instances = [];
  });

  function setup() {
    vi.stubGlobal("EventSource", MockEventSource);
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => useUserEvents(USER_ID), { wrapper });
    return { spy, hook, queryClient };
  }

  /** Calls the spy recorded against exactly the `["inbox"]` key. */
  const inboxCalls = (spy: ReturnType<typeof setup>["spy"]) =>
    spy.mock.calls.filter(
      (call) => JSON.stringify(call[0]?.queryKey) === JSON.stringify(["inbox"]),
    );

  /** Calls the spy recorded against exactly `key`. */
  const callsFor = (spy: ReturnType<typeof setup>["spy"], key: unknown[]) =>
    spy.mock.calls.filter(
      (call) => JSON.stringify(call[0]?.queryKey) === JSON.stringify(key),
    );

  /**
   * Which passes on `key` actually reached the cached page — the recorded
   * predicates replayed against it. "Marked stale" and "refetched" are two
   * `refetchType`s on the same key, so counting calls cannot tell them
   * apart, and an idle QueryClient never refetches either way.
   */
  const matchedPasses = (
    spy: ReturnType<typeof setup>["spy"],
    key: unknown[],
    data: unknown,
    meta?: Record<string, unknown>,
  ) =>
    callsFor(spy, key)
      .filter((call) => {
        const predicate = call[0]?.predicate;
        if (predicate === undefined) return true;
        // Only `state.data` and `meta` are read, so a whole Query is not
        // needed here.
        type Query = Parameters<typeof predicate>[0];
        return predicate({ state: { data }, meta } as Query);
      })
      .map((call) => call[0]?.refetchType ?? "default");

  /**
   * The `meta` a real list cache entry carries (T-279). An entry without one
   * is refetched unconditionally, so a test that omits it where the code
   * reads it would pass for the wrong reason.
   */
  const listMeta = (
    filter: IssueListFilter = {},
    kind: "page" | "counts" = "page",
  ) => ({ issueList: { kind, filter } });

  it("subscribes to the user feed and invalidates on change events", async () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    // Opting in is what makes the server judge each event (T-273).
    expect(source?.url).toBe("/api/events?inbox=1");

    source?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
      project: "todou",
    });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["timeline", "todou", 3] }),
    );
  });

  it("routes each event to its own project's keys (T-122)", async () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    source?.emit("change", {
      entity: "timeline",
      id: 1,
      action: "created",
      issue_number: 3,
      project: "todou",
    });
    source?.emit("change", {
      entity: "timeline",
      id: 2,
      action: "created",
      issue_number: 9,
      project: "other",
    });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ["timeline", "todou", 3] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ["timeline", "other", 9] });
    });
  });

  it("carries the inbox badge for every project (T-112, T-122)", async () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    // No `inbox_row` field, which is what a server predating T-275 sends:
    // the badge still refreshes, at the old cost.
    source?.emit("change", {
      entity: "comment",
      id: 9,
      action: "created",
      issue_number: 3,
      project: "elsewhere",
    });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["inbox"] }),
    );
  });

  /** One change event on issue 7 of todou, carrying `row` as its verdict. */
  const emitInboxRow = (row: InboxRowState | null) => {
    MockEventSource.instances[0]?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 7,
      project: "todou",
      inbox_row: row,
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
  };

  it("leaves the cached inbox alone when the card is not in it", () => {
    // The half T-273 won, kept: not "refetch less often" but "leave the
    // cache untouched" — no refetch and no stale mark.
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const data = cachedInbox(cachedRow({ number: 99 }));
    queryClient.setQueryData(["inbox"], data);
    emitInboxRow(null);

    // The same burst did invalidate what it should, so an implementation
    // that simply never connected could not pass this.
    expect(spy).toHaveBeenCalledWith({ queryKey: ["timeline", "todou", 7] });
    expect(queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(false);
    // Both passes were sent and neither predicate matched — not "no passes
    // were sent at all", which would make every assertion below vacuous.
    expect(inboxCalls(spy)).toHaveLength(2);
    expect(matchedPasses(spy, ["inbox"], data)).toEqual([]);
  });

  it("refetches a null when the cache is still holding that row", () => {
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const data = cachedInbox(cachedRow());
    queryClient.setQueryData(["inbox"], data);
    emitInboxRow(null);

    expect(queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(true);
    expect(matchedPasses(spy, ["inbox"], data)).toEqual(["active"]);
  });

  /**
   * The core of T-275: a change that moved the card but not what the reader
   * has to attend to costs a stale mark, not a request. The badge count is
   * drawn from the attention fields alone, so it stays right; the title and
   * labels catch up on the next focus or mount.
   */
  it("marks the inbox stale without refetching when only the card moved", () => {
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const data = cachedInbox(cachedRow());
    queryClient.setQueryData(["inbox"], data);
    emitInboxRow(fingerprint({ updated_at: LATER }));

    expect(queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["inbox"])?.fetchStatus).toBe("idle");
    expect(matchedPasses(spy, ["inbox"], data)).toEqual(["none"]);
  });

  it("refetches when an attention field moved", () => {
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const data = cachedInbox(cachedRow());
    queryClient.setQueryData(["inbox"], data);
    emitInboxRow(fingerprint({ unread_comments: 5, updated_at: LATER }));

    expect(matchedPasses(spy, ["inbox"], data)).toEqual(["active"]);
  });

  it("refetches when the row is not cached yet", () => {
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const data = cachedInbox();
    queryClient.setQueryData(["inbox"], data);
    emitInboxRow(fingerprint());

    expect(matchedPasses(spy, ["inbox"], data)).toEqual(["active"]);
  });

  it("does nothing at all for an event it has already acted on", () => {
    // Idempotence, which the T-273 boolean could not offer: a replay says
    // the same thing about the same row, and the cache already agrees.
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const data = cachedInbox(cachedRow());
    queryClient.setQueryData(["inbox"], data);
    emitInboxRow(fingerprint());
    emitInboxRow(fingerprint());

    expect(queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(false);
    expect(inboxCalls(spy)).toHaveLength(4);
    expect(matchedPasses(spy, ["inbox"], data)).toEqual([]);
  });

  it("asks the inbox once for a burst about many different cards", () => {
    // A flood of judged events used to cost one aborted-and-restarted
    // refetch per event, because invalidateQueries cancels an in-flight one.
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const source = MockEventSource.instances[0];
    const data = cachedInbox(cachedRow({ number: 3 }));
    queryClient.setQueryData(["inbox"], data);
    for (let i = 1; i <= 12; i++) {
      source?.emit("change", {
        entity: "issue",
        id: i,
        action: "updated",
        issue_number: i,
        project: "other",
        // None of them is in the reader's inbox, except number 3.
        inbox_row: i === 3 ? fingerprint({ unread_comments: 9 }) : null,
      });
    }
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    // Two passes total for the whole burst, one of which matches.
    expect(inboxCalls(spy)).toHaveLength(2);
    expect(matchedPasses(spy, ["inbox"], data)).toEqual(["active"]);
  });

  it("drops a me event this tab caused itself", () => {
    // MarkReadOnView re-sends its PUT about every two seconds on a busy
    // issue, and the mutation's onSettled has already invalidated locally.
    vi.useFakeTimers();
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    source?.emit("me", {
      kind: "prefs",
      origin: clientOrigin,
    });
    // A change event in the same burst still lands, so a listener that was
    // never attached cannot pass this.
    source?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
      project: "todou",
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    expect(spy).toHaveBeenCalledWith({ queryKey: ["timeline", "todou", 3] });
    expect(callsFor(spy, ["me-prefs"])).toHaveLength(0);
  });

  it("acts on a me event from another tab of the same account", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    MockEventSource.instances[0]?.emit("me", {
      kind: "prefs",
      origin: "some-other-tab",
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    expect(spy).toHaveBeenCalledWith({ queryKey: ["me-prefs"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["inbox"] });
  });

  it("acts on a me event with no origin at all (CLI, other device)", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    MockEventSource.instances[0]?.emit("me", { kind: "reads_swept" });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    expect(spy).toHaveBeenCalledWith({ queryKey: ["inbox"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues"] });
  });

  it("refetches one project per slug on a scoped sweep", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    MockEventSource.instances[0]?.emit("me", {
      kind: "reads_swept",
      projects: ["todou", "other"],
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues", "todou"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues", "other"] });
    expect(callsFor(spy, ["issues"])).toHaveLength(0);
  });

  /** One `issue_read` me event about issue 7 of todou. */
  const emitIssueRead = (row: InboxRowState | null) => {
    MockEventSource.instances[0]?.emit("me", {
      kind: "issue_read",
      project: "todou",
      issue_number: 7,
      inbox_row: row,
      origin: "some-other-tab",
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
  };

  it("stays quiet when another tab read a card this one never held", () => {
    // The common case, and the one a broad invalidation would get wrong:
    // reading a card usually takes it out of the inbox, and the other tabs
    // never had it.
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const data = cachedInbox(cachedRow({ number: 99 }));
    queryClient.setQueryData(["inbox"], data);
    emitIssueRead(null);

    expect(queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(false);
    expect(inboxCalls(spy)).toHaveLength(2);
    expect(matchedPasses(spy, ["inbox"], data)).toEqual([]);
  });

  it("refetches when another tab read a card this one is showing", () => {
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    const data = cachedInbox(cachedRow());
    queryClient.setQueryData(["inbox"], data);
    emitIssueRead(null);

    expect(matchedPasses(spy, ["inbox"], data)).toEqual(["active"]);
  });

  it("refetches only the list pages still showing that row unread", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    emitIssueRead(null);

    const lit = {
      items: [{ number: 7, unread: true, unread_comments: 1 }],
      next_cursor: null,
    };
    const clear = {
      items: [{ number: 7, unread: false, unread_comments: 0 }],
      next_cursor: null,
    };
    const elsewhere = {
      items: [{ number: 8, unread: true }],
      next_cursor: null,
    };
    const meta = listMeta();
    expect(matchedPasses(spy, ["issues", "todou"], lit, meta)).toEqual([
      "active",
    ]);
    // No stale mark either: the server has established this row is clear.
    expect(matchedPasses(spy, ["issues", "todou"], clear, meta)).toEqual([]);
    expect(matchedPasses(spy, ["issues", "todou"], elsewhere, meta)).toEqual(
      [],
    );
    // The counts entry has no unread state in it at all.
    expect(
      matchedPasses(
        spy,
        ["issues", "todou"],
        { open: 1 },
        listMeta({}, "counts"),
      ),
    ).toEqual([]);
  });

  it("ignores a malformed me event", () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    for (const listener of source?.listeners.get("me") ?? []) {
      listener({ data: "not json" } as MessageEvent);
    }
    // Valid JSON, unknown kind: fails the MeEvent parse.
    source?.emit("me", { kind: "something-else" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores malformed payloads", () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    for (const listener of source?.listeners.get("change") ?? []) {
      listener({ data: "not json" } as MessageEvent);
    }
    // Valid JSON but no project slug: fails the CrossChangeEvent parse.
    source?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("coalesces an event burst into one flush without duplicates", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    const event = {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
      project: "todou",
    };
    source?.emit("change", event);
    source?.emit("change", { ...event, id: 10 });
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
    const timelineCalls = spy.mock.calls.filter(
      (call) =>
        JSON.stringify(call[0]?.queryKey) ===
        JSON.stringify(["timeline", "todou", 3]),
    );
    expect(timelineCalls).toHaveLength(1);
  });

  it("lets a broad issues refetch subsume a contains-scope in the same window", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    source?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
      project: "todou",
    });
    source?.emit("change", {
      entity: "issue",
      id: 3,
      action: "updated",
      issue_number: 3,
      project: "todou",
    });

    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
    const issuesCalls = spy.mock.calls.filter(
      (call) =>
        JSON.stringify(call[0]?.queryKey) ===
        JSON.stringify(["issues", "todou"]),
    );
    // One broad refetch; no stale-mark/predicate pair from the contains path.
    expect(issuesCalls).toHaveLength(1);
    expect(issuesCalls[0]?.[0]).toEqual({ queryKey: ["issues", "todou"] });
  });

  /**
   * T-101 made a plain comment bump updated_at, which reorders the
   * updated-sorted list — so the pair a comment emits must reach the list
   * broadly, while an unpaired timeline entry must stay narrow. Losing
   * either half shows up as "commented, but the card did not jump".
   */
  it("refetches the list broadly for a comment, narrowly for a bare reference", () => {
    vi.useFakeTimers();
    const listScopes = (spy: ReturnType<typeof setup>["spy"]) =>
      spy.mock.calls
        .filter(
          (call) =>
            JSON.stringify(call[0]?.queryKey) ===
            JSON.stringify(["issues", "todou"]),
        )
        .map((call) => call[0]?.refetchType ?? "default");

    const commented = setup();
    const commentFeed = MockEventSource.instances[0];
    // What createComment publishes: the entry plus the bump's issue event.
    commentFeed?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 3,
      project: "todou",
    });
    commentFeed?.emit("change", {
      entity: "issue",
      id: 3,
      action: "updated",
      issue_number: 3,
      project: "todou",
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
    expect(listScopes(commented.spy)).toEqual(["default"]);

    MockEventSource.instances = [];
    const referenced = setup();
    const refFeed = MockEventSource.instances[0];
    // What recordReferences publishes on the target: a lone timeline entry.
    refFeed?.emit("change", {
      entity: "timeline",
      id: 11,
      action: "created",
      issue_number: 4,
      project: "todou",
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
    // One pass, where this used to be a `"none"` stale-marking sweep of every
    // page followed by a predicated refetch. The sweep is gone (T-279): an
    // event that produces a `contains` verdict cannot move a row's
    // membership, so marking the pages that do not hold it stale only bought
    // the reader a refetch per page on the next focus.
    expect(listScopes(referenced.spy)).toEqual(["active"]);
  });

  it("compensates with broad invalidation after a reconnect", async () => {
    const { spy } = setup();
    const source = MockEventSource.instances[0];
    source?.onerror?.();
    source?.onopen?.();
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["issues"] }),
    );
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("closes the stream on unmount", () => {
    const { hook } = setup();
    hook.unmount();
    expect(MockEventSource.instances[0]?.closed).toBe(true);
  });

  it("rebuilds the stream after EventSource gives up permanently", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    const first = MockEventSource.instances[0] as MockEventSource;

    // A reconnect attempt answered with a non-200 (proxy 502 during a server
    // restart) leaves the browser at CLOSED with no further retries.
    first.readyState = MockEventSource.CLOSED;
    first.onerror?.();
    expect(MockEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(MockEventSource.instances).toHaveLength(2);

    const second = MockEventSource.instances[1] as MockEventSource;
    second.readyState = MockEventSource.OPEN;
    second.onopen?.();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues"] });
  });

  it("keeps backing off while reconnect attempts keep failing", () => {
    vi.useFakeTimers();
    setup();

    for (let i = 0; i < 3; i++) {
      const current = MockEventSource.instances.at(-1) as MockEventSource;
      current.readyState = MockEventSource.CLOSED;
      current.onerror?.();
      vi.advanceTimersByTime(RECONNECT_BASE_MS * 2 ** i);
      expect(MockEventSource.instances).toHaveLength(i + 2);
    }
  });

  it("force-reconnects a silently dead stream after missed heartbeats", () => {
    vi.useFakeTimers();
    const { spy } = setup();
    const first = MockEventSource.instances[0] as MockEventSource;
    first.readyState = MockEventSource.OPEN;
    first.onopen?.();

    // Heartbeats keep the watchdog fed…
    vi.advanceTimersByTime(STALL_TIMEOUT_MS - 1_000);
    first.emit("ping", {});
    vi.advanceTimersByTime(STALL_TIMEOUT_MS - 1_000);
    expect(MockEventSource.instances).toHaveLength(1);

    // …until the stream goes silent past the stall window (dev proxy holds
    // the connection open after the upstream died, so no error ever fires).
    vi.advanceTimersByTime(STALL_TIMEOUT_MS + RECONNECT_BASE_MS);
    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);

    const second = MockEventSource.instances[1] as MockEventSource;
    second.readyState = MockEventSource.OPEN;
    second.onopen?.();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues"] });
  });
});

describe("isSharedKey / shouldAdopt (T-276)", () => {
  it("names the three user-level keys and nothing under them", () => {
    expect(SHARED_QUERY_KEYS).toEqual([["inbox"], ["me-prefs"], ["projects"]]);
    for (const key of SHARED_QUERY_KEYS) expect(isSharedKey(key)).toBe(true);
    // Exact equality, not the prefix match invalidateQueries does: a page's
    // own key must not travel between tabs under a shared prefix.
    expect(isSharedKey(["issues", "todou"])).toBe(false);
    expect(isSharedKey(["inbox", "todou"])).toBe(false);
    expect(isSharedKey(["projects", 1])).toBe(false);
    expect(isSharedKey("inbox")).toBe(false);
  });

  it("adopts anything when the key was never marked stale", () => {
    expect(shouldAdopt(1_000, undefined)).toBe(true);
  });

  it("adopts a response no older than the stale mark, refuses an older one", () => {
    expect(shouldAdopt(1_000, 1_000)).toBe(true);
    expect(shouldAdopt(1_001, 1_000)).toBe(true);
    expect(shouldAdopt(999, 1_000)).toBe(false);
  });
});

/**
 * Layer 2 of T-276: a tab the reader cannot see marks the same queries stale
 * and leaves the request to react-query's focus refetch. Single-tab, because
 * the gate does not depend on sharing — happy-dom's null `navigator.locks`
 * puts these on the degrade path.
 */
describe("useUserEvents visibility gate (T-276)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    focusManager.setFocused(undefined);
    MockEventSource.instances = [];
  });

  const TIMELINE = ["timeline", "todou", 7];

  function setupTab(observed?: {
    queryKey: unknown[];
    queryFn: () => unknown;
    staleTime?: number;
  }) {
    vi.stubGlobal("EventSource", MockEventSource);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    // Two callbacks rather than one with a conditional `useQuery`: the
    // observed query exists because an idle QueryClient never fetches, so
    // "did not refetch" would otherwise be true of every implementation.
    const hook =
      observed === undefined
        ? renderHook(() => useUserEvents(USER_ID), { wrapper })
        : renderHook(
            () => {
              useUserEvents(USER_ID);
              return useQuery(observed);
            },
            { wrapper },
          );
    return { spy, hook, queryClient };
  }

  /** Every recorded pass on `key`, as its `refetchType`. */
  const passes = (
    spy: ReturnType<typeof setupTab>["spy"],
    key: ReadonlyArray<unknown>,
  ): (string | undefined)[] =>
    spy.mock.calls
      .filter(
        (call) => JSON.stringify(call[0]?.queryKey) === JSON.stringify(key),
      )
      .map((call) => call[0]?.refetchType ?? "default");

  const emitTimelineEvent = () => {
    MockEventSource.instances[0]?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 7,
      project: "todou",
    });
  };

  it("marks a hidden tab's queries stale instead of refetching them", () => {
    vi.useFakeTimers();
    focusManager.setFocused(false);
    const { spy, queryClient } = setupTab();
    queryClient.setQueryData(TIMELINE, []);
    emitTimelineEvent();
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    expect(passes(spy, TIMELINE)).toEqual(["none"]);
    expect(queryClient.getQueryState(TIMELINE)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(TIMELINE)?.fetchStatus).toBe("idle");
  });

  it("lets the focus refetch collect what the hidden tab only marked", async () => {
    // Without this the step above only proves "did not fetch"; the whole
    // downgrade rests on the fetch happening on the way back.
    focusManager.setFocused(false);
    const queryFn = vi.fn(() => ["one"]);
    const { queryClient } = setupTab({ queryKey: TIMELINE, queryFn });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    emitTimelineEvent();
    await waitFor(() =>
      expect(queryClient.getQueryState(TIMELINE)?.isInvalidated).toBe(true),
    );
    expect(queryFn).toHaveBeenCalledTimes(1);

    focusManager.setFocused(true);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("takes a long staleTime with it: me-prefs refetches on focus too", async () => {
    // isStaleByTime returns true for an invalidated query whatever its
    // staleTime, so the 60s on ["me-prefs"] is not an exception.
    focusManager.setFocused(false);
    const queryFn = vi.fn(() => ({ show_weak_unread: false }));
    const { queryClient } = setupTab({
      queryKey: ["me-prefs"],
      queryFn,
      staleTime: 60_000,
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    MockEventSource.instances[0]?.emit("me", {
      kind: "prefs",
      origin: "some-other-tab",
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(["me-prefs"])?.isInvalidated).toBe(true),
    );
    expect(queryFn).toHaveBeenCalledTimes(1);

    focusManager.setFocused(true);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("still leaves a hidden tab's cache untouched when nothing concerns it", () => {
    // Only the refetch strength drops; no predicate is skipped. Turning a
    // hidden tab into "mark the whole key stale" would throw away what T-273
    // and T-275 won and cost one /me/inbox on every switch back.
    vi.useFakeTimers();
    focusManager.setFocused(false);
    const { spy, queryClient } = setupTab();
    queryClient.setQueryData(["inbox"], cachedInbox(cachedRow({ number: 99 })));
    queryClient.setQueryData(TIMELINE, []);
    MockEventSource.instances[0]?.emit("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 7,
      project: "todou",
      inbox_row: null,
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    // The same burst did mark something, so this is not vacuous.
    expect(queryClient.getQueryState(TIMELINE)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(false);
    expect(passes(spy, ["inbox"])).toEqual(["none", "none"]);
  });

  it("degrades the reconnect compensation through the same gate", () => {
    // Left as bare invalidateQueries, one dropped connection would walk
    // around the gate entirely.
    focusManager.setFocused(false);
    const { spy } = setupTab();
    const source = MockEventSource.instances[0];
    source?.onerror?.();
    source?.onopen?.();

    const keys = reconnectInvalidations();
    expect(keys.map((key) => passes(spy, key))).toEqual(
      keys.map(() => ["none"]),
    );
  });

  it("changes nothing for a visible tab", () => {
    // The rest of this file is the real proof — 60-odd cases asserting the
    // exact former call shapes, all of them running focused. This one pins
    // the one call that had to grow a conditional.
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const { spy } = setupTab();
    emitTimelineEvent();
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    expect(spy).toHaveBeenCalledWith({ queryKey: TIMELINE });
    expect(passes(spy, TIMELINE)).toEqual(["default"]);
  });
});

/**
 * Layers 1 and 3 of T-276. Two "tabs" are two renderHooks with two
 * QueryClients over one fake LockManager and one fake channel, which is
 * enough to test election, handover, forwarding and adoption; the browser is
 * left for the request counting at the end.
 */
describe("useUserEvents tab sharing (T-276)", () => {
  let restoreTabSync: (() => void) | undefined;

  afterEach(() => {
    restoreTabSync?.();
    restoreTabSync = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    focusManager.setFocused(undefined);
    MockEventSource.instances = [];
  });

  const withTabSync = () => {
    const installed = installTabSync();
    restoreTabSync = installed.restore;
    return installed;
  };

  /** Lets the probe-then-block pair of lock requests inside electLeader run. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  const watchInvalidations = (client: QueryClient) =>
    vi.spyOn(client, "invalidateQueries");

  type Tab = {
    spy: ReturnType<typeof watchInvalidations>;
    queryClient: QueryClient;
    hook: ReturnType<typeof renderHook>;
    /** This tab's own document listeners, by event type. */
    on: Map<string, EventListener[]>;
  };

  function mountTab(): Tab {
    vi.stubGlobal("EventSource", MockEventSource);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = watchInvalidations(queryClient);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    // Both tabs share happy-dom's one document, so dispatching a
    // page-lifecycle event on it would freeze every tab at once — which is
    // the opposite of what the handover has to be tested against. Capture
    // each tab's handlers as it mounts and call just that tab's.
    const on = new Map<string, EventListener[]>();
    const realAdd = document.addEventListener;
    document.addEventListener = function capture(
      this: Document,
      type: string,
      handler: EventListenerOrEventListenerObject | null,
      ...rest: unknown[]
    ) {
      on.set(type, [...(on.get(type) ?? []), handler as EventListener]);
      return (realAdd as (...args: unknown[]) => void).call(
        this,
        type,
        handler,
        ...rest,
      );
    } as typeof document.addEventListener;
    try {
      const hook = renderHook(() => useUserEvents(USER_ID), { wrapper });
      return { spy, queryClient, hook, on };
    } finally {
      document.addEventListener = realAdd;
    }
  }

  /** Two tabs of one account, the first of which holds the lock. */
  async function twoTabs() {
    withTabSync();
    const leader = mountTab();
    await settle();
    const follower = mountTab();
    await settle();
    return { leader, follower };
  }

  /**
   * The one stream the elected leader opened. Asserted rather than reached
   * for with `?.`, which would turn "nobody was elected" into a test that
   * emits nothing and passes.
   */
  const leaderStream = () => {
    expect(MockEventSource.instances).toHaveLength(1);
    return MockEventSource.instances[0] as MockEventSource;
  };

  /** A channel of this account's, standing in for what a sibling sees. */
  const observeChannel = () => {
    const seen: TabMessage[] = [];
    const channel = openTabChannel(`todou:events:${USER_ID}:ch`, (msg) =>
      seen.push(msg),
    );
    return { seen, channel };
  };

  const TIMELINE_EVENT = {
    entity: "timeline",
    id: 9,
    action: "created",
    issue_number: 3,
    project: "todou",
  };

  it("opens one connection for two tabs of the same account", async () => {
    await twoTabs();
    expect(MockEventSource.instances).toHaveLength(1);
    // Still opted in, so the server still judges each event per receiver.
    expect(MockEventSource.instances[0]?.url).toBe("/api/events?inbox=1");
  });

  it("invalidates in both tabs from the leader's single stream", async () => {
    vi.useFakeTimers();
    const { leader, follower } = await twoTabs();
    leaderStream().emit("change", TIMELINE_EVENT);
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    for (const tab of [leader, follower]) {
      expect(tab.spy).toHaveBeenCalledWith({
        queryKey: ["timeline", "todou", 3],
      });
    }
  });

  it("promotes a follower when the leader goes away, and compensates", async () => {
    const { leader, follower } = await twoTabs();
    leader.hook.unmount();
    await settle();

    expect(MockEventSource.instances).toHaveLength(2);
    MockEventSource.instances[1]?.onopen?.();
    // A promoted tab's cache is warm and missed whatever arrived while
    // nobody held the lock, so it has to compensate — unlike a tab whose
    // probe won the lock outright.
    expect(follower.spy).toHaveBeenCalledWith({ queryKey: ["issues"] });
  });

  it("does not compensate a tab whose probe won the lock outright", async () => {
    // The other half of that split: a cold cache pays no extra round of
    // invalidations on every page load.
    withTabSync();
    const first = mountTab();
    await settle();
    MockEventSource.instances[0]?.onopen?.();
    expect(first.spy).not.toHaveBeenCalled();
  });

  it("makes every tab compensate after the leader's stream drops", async () => {
    const { leader, follower } = await twoTabs();
    const stream = leaderStream();
    stream.onerror?.();
    stream.onopen?.();

    expect(leader.spy).toHaveBeenCalledWith({ queryKey: ["issues"] });
    // The followers missed the same events; the `gap` frame is how they hear
    // about it, since an SSE frame carries no id to replay from.
    expect(follower.spy).toHaveBeenCalledWith({ queryKey: ["issues"] });
  });

  it("broadcasts a me frame before filtering this tab's own echo", async () => {
    vi.useFakeTimers();
    const { leader, follower } = await twoTabs();
    const { seen, channel } = observeChannel();

    const echo = { kind: "prefs", origin: clientOrigin };
    leaderStream().emit("me", echo);
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    // The hard constraint of this card: were the origin test applied before
    // the broadcast, the leader's own mark-read would never reach a sibling,
    // reopening the hole T-275 closed. Both renderHooks share one module
    // scope and therefore one `clientOrigin`, so which tab an echo belongs
    // to is not observable in-process — that the frame left at all is.
    expect(seen).toEqual([{ v: 1, frame: "me", data: JSON.stringify(echo) }]);
    for (const tab of [leader, follower]) {
      expect(
        tab.spy.mock.calls.filter(
          (call) =>
            JSON.stringify(call[0]?.queryKey) === JSON.stringify(["me-prefs"]),
        ),
      ).toHaveLength(0);
    }
    channel.close();
  });

  it("acts in both tabs on a me frame from somewhere else", async () => {
    vi.useFakeTimers();
    const { leader, follower } = await twoTabs();
    leaderStream().emit("me", {
      kind: "prefs",
      origin: "some-other-tab",
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    for (const tab of [leader, follower]) {
      expect(tab.spy).toHaveBeenCalledWith({ queryKey: ["me-prefs"] });
      expect(tab.spy).toHaveBeenCalledWith({ queryKey: ["inbox"] });
    }
  });

  it("falls back to a connection per tab where the platform cannot share", async () => {
    // No installTabSync, so `navigator.locks` is happy-dom's null. This is
    // the path every test file that mounts the real shell runs on, and it is
    // byte-for-byte today's behaviour.
    mountTab();
    await settle();
    mountTab();
    await settle();
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("hands the role over when the browser freezes the leader", async () => {
    const { leader, follower } = await twoTabs();
    for (const handler of leader.on.get("freeze") ?? []) {
      handler(new Event("freeze"));
    }
    await settle();

    expect(MockEventSource.instances[0]?.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    MockEventSource.instances[1]?.onopen?.();
    expect(follower.spy).toHaveBeenCalledWith({ queryKey: ["issues"] });

    for (const handler of leader.on.get("resume") ?? []) {
      handler(new Event("resume"));
    }
    await settle();
    // Back in the queue behind the tab that took over, not a third stream.
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("hands a fetched user-level response to the other tab", async () => {
    const { leader, follower } = await twoTabs();
    const inbox = cachedInbox(cachedRow());
    // A real fetch, because only that reaches the reducer without `manual`.
    await leader.queryClient.fetchQuery({
      queryKey: ["inbox"],
      queryFn: () => inbox,
    });

    expect(follower.queryClient.getQueryData(["inbox"])).toEqual(inbox);
    const state = follower.queryClient.getQueryState(["inbox"]);
    expect(state?.isInvalidated).toBe(false);
    // Adopted, not fetched: this QueryClient has no queryFn for the key.
    expect(state?.fetchStatus).toBe("idle");
    expect(state?.dataUpdatedAt).toBe(
      leader.queryClient.getQueryState(["inbox"])?.dataUpdatedAt,
    );
  });

  it("does not echo an adopted response back at the tab that sent it", async () => {
    const { leader, follower } = await twoTabs();
    await leader.queryClient.fetchQuery({
      queryKey: ["inbox"],
      queryFn: () => cachedInbox(cachedRow()),
    });

    // Without the `manual` guard the adoption would look like a fetch and
    // the two tabs would write at each other without stopping.
    expect(leader.queryClient.getQueryState(["inbox"])?.dataUpdateCount).toBe(
      1,
    );
    expect(follower.queryClient.getQueryState(["inbox"])?.dataUpdateCount).toBe(
      1,
    );
  });

  it("refuses a response older than the moment it learned the key was stale", async () => {
    vi.useFakeTimers();
    const { follower } = await twoTabs();
    const held = cachedInbox(cachedRow());
    follower.queryClient.setQueryData(["inbox"], held);

    // An event moves an attention field, so this tab now knows ["inbox"].
    leaderStream().emit("change", {
      entity: "comment",
      id: 9,
      action: "created",
      issue_number: 7,
      project: "todou",
      inbox_row: fingerprint({ unread_comments: 9 }),
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
    expect(follower.queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(
      true,
    );

    const { channel } = observeChannel();
    const fresher = cachedInbox(cachedRow({ unread_comments: 9 }));
    // A sibling's refetch that went out before that moment cannot reflect
    // the event, so adopting it would make stale data look current.
    channel.post({
      v: 1,
      frame: "data",
      key: ["inbox"],
      data: fresher,
      at: Date.now() - 1,
    });
    expect(follower.queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(
      true,
    );
    expect(follower.queryClient.getQueryData(["inbox"])).toEqual(held);

    channel.post({
      v: 1,
      frame: "data",
      key: ["inbox"],
      data: fresher,
      at: Date.now(),
    });
    expect(follower.queryClient.getQueryState(["inbox"])?.isInvalidated).toBe(
      false,
    );
    expect(follower.queryClient.getQueryData(["inbox"])).toEqual(fresher);
    channel.close();
  });

  it("keeps a page's own response off the channel", async () => {
    const { leader } = await twoTabs();
    const { seen, channel } = observeChannel();
    await leader.queryClient.fetchQuery({
      queryKey: ["issues", "todou"],
      queryFn: () => ({ items: [] }),
    });
    await leader.queryClient.fetchQuery({
      queryKey: ["timeline", "todou", 7],
      queryFn: () => [],
    });

    expect(seen).toEqual([]);
    channel.close();
  });

  it("refuses to write a key the whitelist does not name", async () => {
    // What arrives on the channel must not be able to write anywhere.
    const { follower } = await twoTabs();
    const { channel } = observeChannel();
    channel.post({
      v: 1,
      frame: "data",
      key: ["issues", "todou"],
      data: { items: [{ number: 1 }] },
      at: Date.now(),
    });

    expect(
      follower.queryClient.getQueryData(["issues", "todou"]),
    ).toBeUndefined();
    channel.close();
  });

  it("shares each of the three user-level keys", async () => {
    const { leader, follower } = await twoTabs();
    const bodies = new Map<string, unknown>([
      ['["inbox"]', cachedInbox(cachedRow())],
      ['["me-prefs"]', { show_weak_unread: true }],
      ['["projects"]', [{ slug: "todou", name: "Todou" }]],
    ]);
    for (const key of SHARED_QUERY_KEYS) {
      const body = bodies.get(JSON.stringify(key));
      await leader.queryClient.fetchQuery({
        queryKey: [...key],
        queryFn: () => body,
      });
      expect(follower.queryClient.getQueryData([...key])).toEqual(body);
      // ["me-prefs"] carries a 60s staleTime, so a cleared invalidation flag
      // is the difference between "fresh now" and "fresh in a minute".
      expect(follower.queryClient.getQueryState([...key])?.isInvalidated).toBe(
        false,
      );
    }
  });
});

/**
 * The board case T-279 exists for: nine columns cached, a flood of status
 * changes, and eight of the nine with nothing to do about each one. Asserted
 * on the cache rather than on replayed predicates — with no component
 * observing, `refetchType: "active"` leaves a matched query marked
 * invalidated and an unmatched one untouched, so `isInvalidated` is exactly
 * "would this entry have refetched".
 */
describe("issue list judgement (T-279)", () => {
  const SLUG = "todou";
  /** A nine-column board, ids 1–9, the last two closed. */
  const STATUSES = Array.from({ length: 9 }, (_, i) => ({
    id: i + 1,
    name: `s${i + 1}`,
    category: i + 1 >= 8 ? "closed" : "open",
    color: "#123456",
    position: i,
    is_default: i === 0,
  }));

  const row = (
    number: number,
    statusId: number,
    over: { labels?: number[]; assignees?: number[]; unread?: boolean } = {},
  ) => ({
    id: number,
    number,
    title: `card ${number}`,
    status: STATUSES.find((s) => s.id === statusId),
    labels: (over.labels ?? []).map((id) => ({ id, name: `l${id}` })),
    assignees: (over.assignees ?? []).map((id) => ({ id, login: `u${id}` })),
    unread: over.unread ?? false,
    unread_comments: 0,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    MockEventSource.instances = [];
  });

  function setup() {
    vi.stubGlobal("EventSource", MockEventSource);
    focusManager.setFocused(true);
    const queryClient = new QueryClient();
    // The category dimension is judged through this, which every page
    // rendering a status chip already holds.
    queryClient.setQueryData(["statuses", SLUG], STATUSES);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useUserEvents(USER_ID), { wrapper });
    return { spy, queryClient };
  }

  /** Seeds one cache entry through the production `issuesEntry` helper. */
  const seed = (
    queryClient: QueryClient,
    key: readonly unknown[],
    descriptor: Parameters<typeof issuesEntry>[1],
    data: unknown,
  ) =>
    queryClient.fetchQuery({
      ...issuesEntry(key, descriptor),
      queryFn: async () => data,
    });

  const seedColumn = (
    queryClient: QueryClient,
    statusId: number,
    items: unknown[],
  ) =>
    seed(
      queryClient,
      ["issues", SLUG, { board: statusId }],
      { kind: "page", filter: { status: [statusId] } },
      { items, next_cursor: null },
    );

  const invalidated = (queryClient: QueryClient, key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated === true;

  const columnsInvalidated = (queryClient: QueryClient) =>
    STATUSES.filter((s) =>
      invalidated(queryClient, ["issues", SLUG, { board: s.id }]),
    ).map((s) => s.id);

  const emit = (list_row: unknown, number = 7, id = 7) => {
    MockEventSource.instances[0]?.emit("change", {
      entity: "issue",
      id,
      action: "updated",
      issue_number: number,
      project: SLUG,
      ...(list_row === undefined ? {} : { list_row }),
    });
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
  };

  /** Calls the spy recorded against exactly the project's list key. */
  const listCalls = (spy: ReturnType<typeof setup>["spy"]) =>
    spy.mock.calls.filter(
      (call) =>
        JSON.stringify(call[0]?.queryKey) === JSON.stringify(["issues", SLUG]),
    );

  it("touches only the source and target columns of a status change", async () => {
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    for (const status of STATUSES) {
      await seedColumn(
        queryClient,
        status.id,
        status.id === 3 ? [row(7, 3)] : [],
      );
    }

    emit({ kind: "fields", status_id: 5 });

    // 3 holds the row, 5 is where it now belongs. The other seven neither
    // refetch nor go stale — the whole point of the card.
    expect(columnsInvalidated(queryClient)).toEqual([3, 5]);
    // And one call for the lot: `invalidateQueries` cancels in-flight
    // refetches, so a per-verdict call would abort and restart each column.
    expect(listCalls(spy)).toHaveLength(1);
  });

  it("asks each column at most once for a whole flood", async () => {
    vi.useFakeTimers();
    const { spy, queryClient } = setup();
    for (const status of STATUSES) {
      await seedColumn(queryClient, status.id, []);
    }

    const source = MockEventSource.instances[0];
    for (let i = 1; i <= 30; i++) {
      source?.emit("change", {
        entity: "issue",
        id: i,
        action: "updated",
        issue_number: i,
        project: SLUG,
        list_row: { kind: "fields", status_id: 5 },
      });
    }
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);

    expect(listCalls(spy)).toHaveLength(1);
    expect(columnsInvalidated(queryClient)).toEqual([5]);
  });

  it("skips a complete page an activity event cannot have entered", async () => {
    vi.useFakeTimers();
    const { queryClient } = setup();
    const COMPLETE = ["issues", SLUG, { board: 1 }];
    const PARTIAL = ["issues", SLUG, { board: 2 }];
    const HOLDING = ["issues", SLUG, { board: 3 }];
    await seedColumn(queryClient, 1, []);
    await seed(
      queryClient,
      PARTIAL,
      { kind: "page", filter: { status: [2] } },
      { items: [], next_cursor: "c1" },
    );
    await seedColumn(queryClient, 3, [row(7, 3)]);

    emit({ kind: "activity" });

    expect(invalidated(queryClient, COMPLETE)).toBe(false);
    // An incomplete window has to ask: the row may have sat past its edge and
    // moved in when `updated_at` bumped.
    expect(invalidated(queryClient, PARTIAL)).toBe(true);
    expect(invalidated(queryClient, HOLDING)).toBe(true);
  });

  it("refetches only the pages holding a card that went to the trash", async () => {
    vi.useFakeTimers();
    const { queryClient } = setup();
    const COUNTS = ["issues", SLUG, "counts", {}];
    await seedColumn(queryClient, 1, []);
    await seedColumn(queryClient, 3, [row(7, 3)]);
    await seed(
      queryClient,
      COUNTS,
      { kind: "counts", filter: {} },
      { open: 1, closed: 0, by_status: { "3": 1 } },
    );

    emit({ kind: "gone" });

    expect(columnsInvalidated(queryClient)).toEqual([3]);
    // A card leaving takes a count with it, wherever it was.
    expect(invalidated(queryClient, COUNTS)).toBe(true);
  });

  it("judges a label filter from the cached row when the verdict omits it", async () => {
    vi.useFakeTimers();
    const { queryClient } = setup();
    // The row lives in a column, labelled 20; the two filtered lists differ
    // only in which label they ask for.
    const MATCHING = ["issues", SLUG, { label: "20" }];
    const OTHER = ["issues", SLUG, { label: "21" }];
    await seedColumn(queryClient, 3, [row(7, 3, { labels: [20] })]);
    await seed(
      queryClient,
      MATCHING,
      { kind: "page", filter: { label: [20] } },
      { items: [], next_cursor: null },
    );
    await seed(
      queryClient,
      OTHER,
      { kind: "page", filter: { label: [21] } },
      { items: [], next_cursor: null },
    );

    // Only the status moved, so the verdict says nothing about labels and the
    // client's own copy of the row supplies them.
    emit({ kind: "fields", status_id: 5 });

    expect(invalidated(queryClient, MATCHING)).toBe(true);
    expect(invalidated(queryClient, OTHER)).toBe(false);
  });

  it("refetches everything for a text search or the trash", async () => {
    vi.useFakeTimers();
    const { queryClient } = setup();
    const SEARCHED = ["issues", SLUG, { q: "flood" }];
    const TRASH = ["issues", SLUG, { deleted: true }];
    await seed(
      queryClient,
      SEARCHED,
      { kind: "page", filter: { q: "flood" } },
      { items: [], next_cursor: null },
    );
    await seed(
      queryClient,
      TRASH,
      { kind: "page", filter: { deleted: true } },
      { items: [], next_cursor: null },
    );

    // A verdict any other page would judge "no": `q` matches bodies, which no
    // list row carries, and the trash orders by deletion time.
    emit({ kind: "fields", status_id: 5, label_ids: [], assignee_ids: [] });

    expect(invalidated(queryClient, SEARCHED)).toBe(true);
    expect(invalidated(queryClient, TRASH)).toBe(true);
  });

  it("refetches an entry that declares nothing", async () => {
    vi.useFakeTimers();
    const { queryClient } = setup();
    const UNDECLARED = ["issues", SLUG, { future: true }];
    await queryClient.fetchQuery({
      queryKey: UNDECLARED,
      queryFn: async () => ({ items: [], next_cursor: null }),
    });

    emit({ kind: "fields", status_id: 5, label_ids: [], assignee_ids: [] });

    // A producer added later without a declaration loses the optimization,
    // never correctness.
    expect(invalidated(queryClient, UNDECLARED)).toBe(true);
  });

  it("refetches every entry when the event carries no verdict", async () => {
    vi.useFakeTimers();
    const { queryClient } = setup();
    for (const status of STATUSES) {
      await seedColumn(queryClient, status.id, []);
    }

    emit(undefined);

    expect(columnsInvalidated(queryClient)).toEqual(STATUSES.map((s) => s.id));
  });

  it("leaves the counts alone unless membership could have moved", async () => {
    vi.useFakeTimers();
    const { queryClient } = setup();
    const COUNTS = ["issues", SLUG, "counts", {}];
    await seedColumn(queryClient, 3, [row(7, 3)]);
    await seed(
      queryClient,
      COUNTS,
      { kind: "counts", filter: {} },
      { open: 1, closed: 0, by_status: { "3": 1 } },
    );

    // `updated_at` and the badges are not in a count.
    emit({ kind: "activity" });
    expect(invalidated(queryClient, COUNTS)).toBe(false);

    // A save that named the status but did not change it: the cached row says
    // so, and no count moved either.
    emit({ kind: "fields", status_id: 3 });
    expect(invalidated(queryClient, COUNTS)).toBe(false);

    emit({ kind: "fields", status_id: 5 });
    expect(invalidated(queryClient, COUNTS)).toBe(true);
  });

  it("finds a cached row through any page of the project", async () => {
    vi.useFakeTimers();
    const { queryClient } = setup();
    await seedColumn(queryClient, 1, []);
    await seedColumn(queryClient, 3, [row(7, 3, { labels: [20] })]);

    expect(
      cachedIssueRow(queryClient, ["issues", SLUG], 7)?.labels.map((l) => l.id),
    ).toEqual([20]);
    expect(cachedIssueRow(queryClient, ["issues", SLUG], 99)).toBeUndefined();
  });
});
