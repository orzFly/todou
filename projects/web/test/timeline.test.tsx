import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render as renderBare,
  waitFor,
} from "@testing-library/react";
import type {
  Label,
  QuestionsComponent,
  Status,
  TimelineComment,
  TimelineEvent,
  TimelineItem,
  TimelinePage,
  UserRef,
} from "@todou/shared";
import { DEFAULT_REFERENCE_CONFIG } from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refConfigFor } from "../src/api/references.ts";
import {
  flattenTimeline,
  latestNextCursor,
  mergeFolded,
  needsHead,
  remainingCount,
  shouldFollowBottom,
} from "../src/api/timeline.ts";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import {
  type EventRenderContext,
  EventRow,
  renderEvent,
} from "../src/components/timeline/event-row.tsx";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import {
  NO_ENTITIES,
  resolveLabel,
  resolveStatus,
  resolveUser,
} from "../src/components/timeline/use-event-entities.ts";
import {
  renderWithProviders as renderWithRouter,
  testQueryClient,
} from "./render.tsx";

// CommentItem mounts an edit mutation, which needs a query client.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderBare(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const user: UserRef = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const bot: UserRef = {
  id: 2,
  login: "worker-bot",
  display_name: "Worker Bot",
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "user" },
};

const questionComment = (
  id: number,
  comp: QuestionsComponent,
): TimelineComment => ({
  type: "comment",
  id,
  author: user,
  body: `c${id}`,
  component: comp,
  created_at: "2026-08-11T00:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const eventOf = (
  event_type: TimelineEvent["event_type"],
  payload: Record<string, unknown>,
): TimelineEvent => ({
  type: "event",
  id: 1,
  event_type,
  actor: user,
  payload,
  created_at: "2026-08-11T00:00:00Z",
  agent_context: null,
});

const BARE_CTX: EventRenderContext = {
  refConfig: refConfigFor(undefined),
  slugEntries: [],
  entities: NO_ENTITIES,
};

const textOf = (
  type: TimelineEvent["event_type"],
  payload: Record<string, unknown> = {},
  ctx: EventRenderContext = BARE_CTX,
) => renderEvent(eventOf(type, payload), ctx).text;

describe("renderEvent text mirror", () => {
  it("covers the GitHub-style action vocabulary", () => {
    expect(textOf("opened")).toBe("opened this issue");
    expect(textOf("closed", { to: { name: "Done" } })).toBe(
      "closed this (Done)",
    );
    expect(textOf("reopened", { to: { name: "Todo" } })).toBe(
      "reopened this (Todo)",
    );
    expect(
      textOf("status_changed", {
        from: { name: "Todo" },
        to: { name: "In Progress" },
      }),
    ).toBe("moved Todo → In Progress");
    expect(textOf("title_changed", { from: "a", to: "b" })).toBe(
      'renamed "a" → "b"',
    );
    expect(textOf("label_added", { label: { name: "bug" } })).toBe(
      "added label bug",
    );
    expect(textOf("label_removed", { label: { name: "bug" } })).toBe(
      "removed label bug",
    );
    expect(textOf("assigned", { user: { login: "worker-bot" } })).toBe(
      "assigned @worker-bot",
    );
    expect(textOf("unassigned", { user: { login: "worker-bot" } })).toBe(
      "unassigned @worker-bot",
    );
    expect(textOf("referenced", { by_issue: 7 })).toBe("referenced by #7");
    expect(textOf("cross_referenced", { by_project: "web", by_issue: 4 })).toBe(
      "referenced by web#4",
    );
    expect(
      textOf("attachment_added", { attachment: { filename: "a.txt" } }),
    ).toBe("attached a.txt");
    expect(textOf("question_answered", { answers: [1] })).toBe(
      "answered 1 question",
    );
    expect(textOf("deleted")).toBe("moved this to the trash");
    expect(textOf("restored")).toBe("restored this from the trash");
  });

  it("covers the spec vocabulary (T-23)", () => {
    expect(
      textOf("spec_pushed", {
        version: 3,
        message: "address review",
        added: ["extra.md"],
        changed: ["design.md"],
        removed: [],
      }),
    ).toBe("pushed spec v3 (1 added, 1 changed) — address review");
    expect(
      textOf("spec_pushed", {
        version: 1,
        message: null,
        added: ["a.md", "b.md"],
        changed: [],
        removed: [],
      }),
    ).toBe("pushed spec v1 (2 added)");
    expect(
      textOf("spec_review", {
        version: 3,
        verdict: "approve",
        annotation_count: 0,
      }),
    ).toBe("approved spec v3");
    expect(
      textOf("spec_review", {
        version: 3,
        verdict: "request_changes",
        annotation_count: 2,
      }),
    ).toBe("requested changes on spec v3 with 2 comments");
    // A round that judged nothing (T-277) reads as neither of the two.
    expect(
      textOf("spec_review", {
        version: 3,
        verdict: "comment",
        annotation_count: 3,
      }),
    ).toBe("commented on spec v3 with 3 comments");
    expect(
      textOf("spec_review", {
        version: 3,
        verdict: "comment",
        annotation_count: 0,
      }),
    ).toBe("commented on spec v3");
    expect(textOf("spec_comments_resolved", { comment_ids: [4, 5] })).toBe(
      "resolved 2 spec comments",
    );
  });

  it("names the assignee the way the rest of the app does (T-171)", () => {
    const entities = {
      ...NO_ENTITIES,
      memberById: new Map([[bot.id, bot]]),
    };
    expect(
      textOf(
        "unassigned",
        { user: { id: bot.id, login: bot.login } },
        {
          ...BARE_CTX,
          entities,
        },
      ),
    ).toBe("unassigned Worker Bot");
  });
});

describe("event entity resolution", () => {
  const current: Label = { id: 1, name: "area:web", color: "#00ff00" };
  const currentStatus: Status = {
    id: 4,
    name: "Shipped",
    category: "closed",
    color: "#8b5cf6",
    position: 5,
    is_default: false,
  };

  it("prefers the label as it looks today over the payload snapshot", () => {
    const byId = new Map([[current.id, current]]);
    expect(
      resolveLabel({ id: 1, name: "area:frontend", color: "#ff0000" }, byId),
    ).toEqual(current);
  });

  it("keeps a deleted label's snapshot, and shapes an id-only race", () => {
    const gone = { id: 9, name: "kind:legacy", color: "#ff0000" };
    expect(resolveLabel(gone, new Map())).toEqual(gone);
    expect(resolveLabel({ id: 9 }, new Map())).toEqual({
      id: 9,
      name: "?",
      color: "#6b7280",
    });
  });

  it("recolors a status from the project, and greys out a deleted one", () => {
    const byId = new Map([[currentStatus.id, currentStatus]]);
    expect(resolveStatus({ id: 4, name: "Ready to Ship" }, byId)).toEqual(
      currentStatus,
    );
    expect(resolveStatus({ id: 77, name: "Parked" }, new Map())).toEqual({
      name: "Parked",
      color: "#6b7280",
    });
  });

  it("falls back to @login for someone who left the project", () => {
    expect(resolveUser({ id: 2, login: "worker-bot" }, new Map())).toEqual({
      user: null,
      text: "@worker-bot",
    });
    expect(
      resolveUser({ id: bot.id, login: bot.login }, new Map([[bot.id, bot]])),
    ).toEqual({ user: bot, text: "Worker Bot" });
  });
});

describe("shouldFollowBottom", () => {
  it("follows within one viewport of the bottom", () => {
    expect(shouldFollowBottom(1800, 3000, 800)).toBe(true);
  });
  it("does not follow when scrolled far up", () => {
    expect(shouldFollowBottom(100, 3000, 800)).toBe(false);
  });
});

describe("timeline paging helpers", () => {
  const page = (
    ids: number[],
    next: string | null,
    prev: string | null = null,
    total = ids.length,
  ): TimelinePage => ({
    items: ids.map((id) => ({
      type: "comment",
      id,
      author: user,
      body: `c${id}`,
      component: null,
      created_at: "2026-08-11T00:00:00Z",
      edited_at: null,
      resolved_at: null,
      hidden_at: null,
      agent_context: null,
    })),
    prev_cursor: prev,
    next_cursor: next,
    total_count: total,
  });

  it("finds the newest non-null next cursor across pages", () => {
    expect(latestNextCursor([page([1], "A"), page([], null)])).toBe("A");
    expect(latestNextCursor([page([1], "A"), page([2], "B")])).toBe("B");
    expect(latestNextCursor([page([], null)])).toBeNull();
  });

  it("flattens pages with dedup (SSE poll overlap)", () => {
    const items = flattenTimeline([page([1, 2], "A"), page([2, 3], "B")]);
    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it("enables the head query only when the tail missed the start", () => {
    expect(needsHead(undefined)).toBe(false);
    expect(needsHead(page([1, 2], "A", null))).toBe(false);
    expect(needsHead(page([5, 6], "A", "P"))).toBe(true);
  });

  it("merges the fold sides with cross-seam dedup", () => {
    const { above, below } = mergeFolded(
      [page([1, 2], "A"), page([3, 4], "B")],
      [page([4, 5, 6], "C")],
    );
    expect(above.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(below.map((i) => i.id)).toEqual([5, 6]);
  });

  it("counts the folded remainder and clamps stale totals", () => {
    const disjoint = mergeFolded([page([1, 2], "A")], [page([7, 8], "C")]);
    expect(remainingCount(8, disjoint.above, disjoint.below)).toBe(4);

    // Fully overlapping sides (small issue): nothing remains.
    const overlap = mergeFolded([page([1, 2, 3], "A")], [page([1, 2, 3], "C")]);
    expect(remainingCount(3, overlap.above, overlap.below)).toBe(0);

    // A total that lags behind what is already rendered must clamp to 0
    // instead of re-folding the seam.
    expect(remainingCount(3, disjoint.above, disjoint.below)).toBe(0);
  });
});

describe("timeline rendering", () => {
  it("renders comments with markdown bodies", async () => {
    const { getByText } = renderWithRouter(
      <CommentItem
        slug="p"
        issueNumber={1}
        comment={{
          type: "comment",
          id: 1,
          author: user,
          body: "**bold potato**",
          component: null,
          created_at: "2026-08-11T00:00:00Z",
          edited_at: null,
          resolved_at: null,
          hidden_at: null,
          agent_context: null,
        }}
      />,
    );
    await waitFor(() => expect(getByText("bold potato")).toBeTruthy());
  });

  it("renders agent actors with their badge in event rows", () => {
    const { getByTitle, container } = render(
      <EventRow
        event={{
          type: "event",
          id: 1,
          event_type: "closed",
          actor: bot,
          payload: { to: { name: "Done" } },
          created_at: "2026-08-11T00:00:00Z",
          agent_context: null,
        }}
      />,
    );
    expect(getByTitle("closed this (Done)").textContent).toBe(
      "closed this Done",
    );
    expect(container.querySelector('[aria-label="agent"]')).toBeTruthy();
  });
});

const SLUG = "p";

/** An issue page has these three queries warm before any event renders. */
function seededClient(seed: {
  labels?: Label[];
  statuses?: Status[];
  members?: UserRef[];
}) {
  const client = testQueryClient();
  client.setQueryData(["labels", SLUG], seed.labels ?? []);
  client.setQueryData(["statuses", SLUG], seed.statuses ?? []);
  client.setQueryData(
    ["members", SLUG],
    (seed.members ?? []).map((u) => ({
      user: u,
      role: "writer",
      created_at: "2026-01-01T00:00:00Z",
    })),
  );
  return client;
}

const row = (
  event_type: TimelineEvent["event_type"],
  payload: Record<string, unknown>,
  seed: Parameters<typeof seededClient>[0] = {},
) =>
  renderWithRouter(
    <EventRow
      event={{ ...eventOf(event_type, payload), actor: user }}
      slug={SLUG}
      issueNumber={1}
    />,
    seededClient(seed),
  );

describe("timeline entities render like the rest of the app (T-171)", () => {
  it("shows an assignee as a user chip, not a login", async () => {
    const { findByText, queryByText } = row(
      "unassigned",
      { user: { id: bot.id, login: bot.login } },
      { members: [bot] },
    );
    await findByText("Worker Bot");
    expect(queryByText("@worker-bot")).toBeNull();
  });

  it("degrades to @login when the assignee is no longer a member", async () => {
    const { findByText } = row("assigned", {
      user: { id: 99, login: "ex-member" },
    });
    await findByText("@ex-member");
  });

  it("renders labels as chips carrying the project's current name", async () => {
    const { findByTitle } = row(
      "label_added",
      { label: { id: 1, name: "area:frontend", color: "#ff0000" } },
      { labels: [{ id: 1, name: "area:web", color: "#00ff00" }] },
    );
    // LabelChip's title is the full label name — the snapshot lost the race.
    const chip = await findByTitle("area:web");
    expect(chip.textContent).toBe("area:web");
  });

  it("renders a status move as a pill on each side", async () => {
    const { findByTitle, container } = row("status_changed", {
      from: { id: 1, name: "Todo" },
      to: { id: 2, name: "In Progress" },
    });
    const action = await findByTitle("moved Todo → In Progress");
    expect(action.textContent).toBe("moved Todo → In Progress");
    expect(action.querySelectorAll("span[aria-hidden]")).toHaveLength(2);
    expect(container.textContent).toContain("In Progress");
  });

  it("strikes the old title and emphasizes the new one", async () => {
    const { findByText } = row("title_changed", { from: "old", to: "new" });
    const before = await findByText("old");
    expect(before.className).toContain("line-through");
    expect((await findByText("new")).className).toContain("font-medium");
  });
});

describe("timeline answers reach the question card (T-365)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders an answered footer without asking /questions", async () => {
    const comp: QuestionsComponent = {
      type: "questions",
      questions: [
        {
          key: "q1",
          multiple: false,
          question: "Ship it?",
          options: [{ label: "yes" }, { label: "no" }],
        },
      ],
    };
    const event = {
      type: "event",
      id: 9,
      event_type: "question_answered",
      actor: user,
      payload: {
        comment_id: 42,
        answers: [
          {
            key: "q1",
            selected: [{ index: 0, label: "yes" }],
            other: null,
            declined: false,
          },
        ],
      },
      created_at: "2026-08-11T00:00:00Z",
      agent_context: null,
    } as const;
    const page: TimelinePage = {
      items: [questionComment(42, comp), event],
      prev_cursor: null,
      next_cursor: null,
      total_count: 2,
    };
    const gets: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && /\/projects\/p\/issues\/19\/timeline/.test(url)) {
        return Response.json(page);
      }
      if (method === "GET" && url.includes("/references/config")) {
        return Response.json(DEFAULT_REFERENCE_CONFIG);
      }
      if (method === "GET" && url.includes("/reference-directory")) {
        return Response.json(null);
      }
      if (method === "GET" && url.includes("/questions")) {
        gets.push(`${method} ${url}`);
        return Response.json({ items: [], open: 0 });
      }
      if (method === "GET") {
        return Response.json([]);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const { findByText } = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      testQueryClient(),
    );

    // First paint already carries the verdict — the timeline event in the
    // loaded window is the whole proof, no /questions request needed.
    await findByText("answered by");
    expect(gets.filter((g) => g.includes("/questions"))).toEqual([]);
  });
});

describe("timeline load failure (T-376)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A fetch stub where the initial tail request (`?last=1`) goes to
   * `tailPage` and every other timeline GET goes to `headPage`. `calls`
   * records each timeline GET with its query string, so a test can tell
   * the two halves apart. */
  const aPage = (ids: number[]): TimelinePage => ({
    items: ids.map((id) => ({
      type: "comment",
      id,
      author: user,
      body: `c${id}`,
      component: null,
      created_at: "2026-08-11T00:00:00Z",
      edited_at: null,
      resolved_at: null,
      hidden_at: null,
      agent_context: null,
    })),
    prev_cursor: null,
    next_cursor: null,
    total_count: ids.length,
  });
  function stubTimeline(
    tailPage: () => Response | Promise<Response>,
    headPage: () => Response | Promise<Response> = () =>
      Response.json(aPage([1])),
  ) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && /\/projects\/p\/issues\/19\/timeline/.test(url)) {
        calls.push(url);
        return url.includes("last=1") ? tailPage() : headPage();
      }
      if (method === "GET" && url.includes("/references/config")) {
        return Response.json(DEFAULT_REFERENCE_CONFIG);
      }
      if (method === "GET" && url.includes("/reference-directory")) {
        return Response.json(null);
      }
      if (method === "GET" && url.includes("/questions")) {
        return Response.json({ items: [], open: 0 });
      }
      if (method === "GET") {
        return Response.json([]);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    return calls;
  }

  it("offers Retry and recovers the timeline when it succeeds", async () => {
    let failing = true;
    const calls = stubTimeline(() =>
      failing
        ? // The server's error envelope, not a bare string: the client
          // reads body.error.message, and a string here would fall through
          // to the HTTP status as the message.
          Response.json(
            {
              error: { code: "internal", message: "timeline unavailable" },
            },
            { status: 500 },
          )
        : Response.json(aPage([7, 8])),
    );
    const { findByText, findByRole, queryByText } = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      testQueryClient(),
    );
    expect(
      await findByText("Failed to load timeline: timeline unavailable"),
    ).toBeTruthy();
    failing = false;
    fireEvent.click(await findByRole("button", { name: "Retry" }));
    await findByText("c7");
    expect(queryByText(/Failed to load timeline/)).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("refetches only the failed half when tail is healthy and head is not", async () => {
    // Tail succeeds but reports an older start, which enables the head
    // query; the head fetch then 500s. Retry must re-issue the head
    // request only — the tail's own GET must not repeat.
    const healthyTail = { ...aPage([8]), prev_cursor: "P1" };
    const calls = stubTimeline(
      () => Response.json(healthyTail),
      () =>
        Promise.resolve(
          Response.json(
            { error: { code: "internal", message: "head gone" } },
            { status: 500 },
          ),
        ),
    );
    const { findByText, findByRole } = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      testQueryClient(),
    );
    await findByText(/Failed to load timeline: /);
    const tailCallsBefore = calls.filter((u) => u.includes("last=1")).length;
    fireEvent.click(await findByRole("button", { name: "Retry" }));
    // The retried head fetch resolves 500 again; wait for it to land so
    // the call count is settled before comparing.
    await waitFor(() =>
      expect(calls.filter((u) => !u.includes("last=1")).length).toBe(2),
    );
    expect(calls.filter((u) => u.includes("last=1"))).toHaveLength(
      tailCallsBefore,
    );
  });
});

describe("one upload across the fold seam (T-404)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const session = {
    agent: "claude-code",
    model: "model-alpha",
    session_id: "session-a",
  } as const;
  const EPOCH = Date.parse("2026-09-16T09:00:00.000Z");
  const at = (n: number) => new Date(EPOCH + n * 1000).toISOString();

  const commentAt = (n: number): TimelineComment => ({
    type: "comment",
    id: n,
    author: user,
    body: `c${n}`,
    component: null,
    created_at: at(n),
    edited_at: null,
    resolved_at: null,
    hidden_at: null,
    agent_context: null,
  });

  const uploadAt = (n: number): TimelineEvent => ({
    type: "event",
    id: n,
    event_type: "attachment_added",
    actor: bot,
    payload: { attachment: { id: n, filename: `seam-${n}.png` } },
    created_at: at(n),
    agent_context: session,
  });

  /** `total` entries where each `[from, count]` (1-based) is one upload and
      every other entry is a comment. */
  const card = (
    total: number,
    ...uploads: Array<[from: number, count: number]>
  ): TimelineItem[] =>
    Array.from({ length: total }, (_, i) =>
      uploads.some(([from, count]) => i + 1 >= from && i + 1 < from + count)
        ? uploadAt(i + 1)
        : commentAt(i + 1),
    );

  const pageOf = (
    items: TimelineItem[],
    total: number,
    cursors: { prev?: string; next?: string } = {},
  ): TimelinePage => ({
    items,
    prev_cursor: cursors.prev ?? null,
    next_cursor: cursors.next ?? null,
    total_count: total,
  });

  /** Timeline GETs routed by query string: `last=1` is the tail's first page,
      an `after=` cursor is a fold expansion, and the bare request is the
      head's first page (keyed `""`). */
  function stubCard(tail: TimelinePage, head: Record<string, TimelinePage>) {
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && /\/projects\/p\/issues\/19\/timeline/.test(url)) {
        if (url.includes("last=1")) return Response.json(tail);
        const after =
          new URL(url, "http://todou.example").searchParams.get("after") ?? "";
        const page = head[after];
        if (!page) throw new Error(`no head page for after="${after}"`);
        return Response.json(page);
      }
      if (method === "GET" && url.includes("/references/config")) {
        return Response.json(DEFAULT_REFERENCE_CONFIG);
      }
      if (method === "GET" && url.includes("/reference-directory")) {
        return Response.json(null);
      }
      if (method === "GET" && url.includes("/questions")) {
        return Response.json({ items: [], open: 0 });
      }
      if (method === "GET") {
        return Response.json([]);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  const attachedGroups = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="event-group"]')].filter((g) =>
      /attached/.test(g.textContent ?? ""),
    );

  it("renders one group for the upload the two 50-item windows split", async () => {
    // The card as reported: 59 entries, the last 50 of them the tail's page
    // and the first 50 the head's, so the seam falls between 50 and 51 and
    // the upload at 49–54 straddles it.
    const items = card(59, [49, 6]);
    stubCard(pageOf(items.slice(9), 59, { prev: "P" }), {
      "": pageOf(items.slice(0, 50), 59, { next: "H1" }),
    });
    const { container, findByText, getAllByText, queryByTestId } =
      renderWithRouter(
        <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
        testQueryClient(),
      );

    // Wait on an entry only the head carries. Before it lands `above` is
    // empty, all six events sit in the tail, and the page already shows one
    // group — asserting any earlier would pass without the fix.
    await findByText("c1");
    // And with the seam closed, which is what makes one group the right
    // answer: two windows still holding a fold between them may split it.
    expect(queryByTestId("fold-block")).toBeNull();

    const groups = attachedGroups(container);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain("attached 6 files");
    for (let n = 49; n <= 54; n++) {
      expect(getAllByText(`seam-${n}.png`)).toHaveLength(1);
    }
  });

  it("re-merges the upload once Load more closes the seam", async () => {
    // Over 100 entries, so the fold block is real at first and splitting the
    // upload 3/3 is correct — until the reader expands the head to the tail.
    const items = card(150, [98, 6]);
    stubCard(pageOf(items.slice(100), 150, { prev: "P" }), {
      "": pageOf(items.slice(0, 50), 150, { next: "H1" }),
      H1: pageOf(items.slice(50, 100), 150, { next: "H2" }),
    });
    const { container, findByRole, findByTestId, queryByTestId } =
      renderWithRouter(
        <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
        testQueryClient(),
      );

    expect((await findByTestId("fold-block")).textContent).toContain(
      "50 remaining items",
    );
    await waitFor(() => {
      const split = attachedGroups(container);
      expect(split).toHaveLength(1);
      expect(split[0]?.textContent).toContain("attached 3 files");
    });

    fireEvent.click(await findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(queryByTestId("fold-block")).toBeNull());

    const groups = attachedGroups(container);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain("attached 6 files");
  });

  it("keeps two uploads apart while the fold block still sits between them", async () => {
    // Two separate uploads, one at the end of the head window and one at the
    // start of the tail, close enough in time and from the same session that
    // the merge rule would join them if they were adjacent. Fifty unloaded
    // entries are all that keep them apart, so grouping has to read the same
    // seam the fold block does.
    const items = card(150, [49, 2], [101, 2]);
    stubCard(pageOf(items.slice(100), 150, { prev: "P" }), {
      "": pageOf(items.slice(0, 50), 150, { next: "H1" }),
    });
    const { container, findByTestId } = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      testQueryClient(),
    );

    await findByTestId("fold-block");
    await waitFor(() => {
      const groups = attachedGroups(container);
      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.textContent)).toEqual([
        expect.stringContaining("attached 2 files"),
        expect.stringContaining("attached 2 files"),
      ]);
    });
  });
});
