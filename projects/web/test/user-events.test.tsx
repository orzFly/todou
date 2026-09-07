import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { CrossChangeEvent, InboxRowState, MeEvent } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientOrigin } from "../src/api/queries.ts";
import {
  coalesceBatch,
  INVALIDATE_COALESCE_MS,
  inboxAttentionDiffers,
  inboxInvalidations,
  inboxRowContentDiffers,
  inboxRowIn,
  invalidationsFor,
  meInvalidations,
  pageContainsIssue,
  pageHasUnreadRow,
  RECONNECT_BASE_MS,
  reconnectInvalidations,
  STALL_TIMEOUT_MS,
  useUserEvents,
} from "../src/api/useUserEvents.ts";

const AT = "2026-09-07T10:00:00.000Z";
const LATER = "2026-09-07T11:00:00.000Z";

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
  it("maps issue events to broad refetches (status may move columns)", () => {
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
      { key: ["issues", "todou"], scope: { contains: 7 } },
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
      { key: ["issues", "todou"], scope: { stillUnread: [7] } },
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

  it("merges stillUnread the same way", () => {
    expect(
      coalesceBatch([
        { key: ["issues", "todou"], scope: { stillUnread: [1] } },
        { key: ["issues", "todou"], scope: { stillUnread: [2] } },
        { key: ["issues", "other"], scope: { stillUnread: [3] } },
      ]),
    ).toEqual([
      { key: ["issues", "todou"], scope: { stillUnread: [1, 2] } },
      { key: ["issues", "other"], scope: { stillUnread: [3] } },
    ]);
  });

  it("lets a broad refetch subsume the narrower scopes on its key", () => {
    expect(
      coalesceBatch([
        { key: ["inbox"], scope: { inboxRows: [verdict(1)] } },
        { key: ["inbox"], scope: "refetch" },
        { key: ["issues", "todou"], scope: { contains: 4 } },
      ]),
    ).toEqual([
      { key: ["inbox"], scope: "refetch" },
      { key: ["issues", "todou"], scope: { contains: 4 } },
    ]);
  });

  it("collapses identical descriptors and keeps distinct contains apart", () => {
    expect(
      coalesceBatch([
        { key: ["timeline", "todou", 3], scope: "refetch" },
        { key: ["timeline", "todou", 3], scope: "refetch" },
        { key: ["issues", "todou"], scope: { contains: 3 } },
        { key: ["issues", "todou"], scope: { contains: 4 } },
      ]),
    ).toEqual([
      { key: ["timeline", "todou", 3], scope: "refetch" },
      { key: ["issues", "todou"], scope: { contains: 3 } },
      { key: ["issues", "todou"], scope: { contains: 4 } },
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
    const hook = renderHook(() => useUserEvents(), { wrapper });
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
  ) =>
    callsFor(spy, key)
      .filter((call) => {
        const predicate = call[0]?.predicate;
        if (predicate === undefined) return true;
        // Only `state.data` is read, so a whole Query is not needed here.
        type Query = Parameters<typeof predicate>[0];
        return predicate({ state: { data } } as Query);
      })
      .map((call) => call[0]?.refetchType ?? "default");

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

    const lit = { items: [{ number: 7, unread: true, unread_comments: 1 }] };
    const clear = { items: [{ number: 7, unread: false, unread_comments: 0 }] };
    const elsewhere = { items: [{ number: 8, unread: true }] };
    expect(matchedPasses(spy, ["issues", "todou"], lit)).toEqual(["active"]);
    // No stale mark either: the server has established this row is clear.
    expect(matchedPasses(spy, ["issues", "todou"], clear)).toEqual([]);
    expect(matchedPasses(spy, ["issues", "todou"], elsewhere)).toEqual([]);
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
    expect(listScopes(referenced.spy)).toEqual(["none", "active"]);
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
