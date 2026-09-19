import { act, fireEvent, waitFor } from "@testing-library/react";
import type {
  Issue,
  Label,
  QuestionsComponent,
  SpecCommentItem,
  Status,
  TimelineComment,
  TimelineEvent,
  TimelineItem,
  TimelinePage,
  UserRef,
} from "@todou/shared";
import { DEFAULT_REFERENCE_CONFIG } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueQuery } from "../src/api/issues.ts";
import { refConfigFor } from "../src/api/references.ts";
import { specCommentsQuery } from "../src/api/spec.ts";
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
  iconForEvent,
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

const annotation = (
  id: number,
  over: Partial<SpecCommentItem> = {},
): SpecCommentItem => ({
  comment_id: id,
  author: user,
  created_at: "2026-08-11T00:00:00Z",
  body: "why not a column?",
  hidden_at: null,
  anchor: {
    path: "design.md",
    version: 2,
    line_start: 42,
    line_end: 48,
    col_start: null,
    col_end: null,
    quote: "one read-time count",
  },
  resolved: null,
  outdated: false,
  current_line_start: 42,
  current_line_end: 48,
  ...over,
});

const ctxWith = (...items: SpecCommentItem[]): EventRenderContext => ({
  ...BARE_CTX,
  specAnnotations: new Map(items.map((i) => [i.comment_id, i])),
});

describe("renderEvent text mirror", () => {
  it("degrades an event type added by a newer server", () => {
    const event = eventOf("future_event" as TimelineEvent["event_type"], {});
    expect(() => renderEvent(event, BARE_CTX)).not.toThrow();
    expect(renderEvent(event, BARE_CTX).text).toBe(
      "logged an unknown event: future_event",
    );
    expect(iconForEvent("future_event")).toBeTruthy();
  });

  it("keeps master's spec_withdrawn event recognized after integration", () => {
    const result = renderEvent(
      eventOf("spec_withdrawn", { version: 3, reason: "reworking scope" }),
      BARE_CTX,
    );
    expect(result.text).toBe("withdrew spec v3 · reworking — reworking scope");
    expect(result.text).not.toContain("unknown event");
  });

  it.each([undefined, null, "", 42])(
    "does not disguise a missing event_type as a future event: %j",
    (value) => {
      const type = value as TimelineEvent["event_type"];
      expect(() => renderEvent(eventOf(type, {}), BARE_CTX)).toThrow(TypeError);
      expect(() => iconForEvent(type)).toThrow(TypeError);
    },
  );
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
    // Ids that are not ids: nothing to name, so the sentence falls back to
    // the count, which the payload still carries. The app never draws this
    // face — the group does — so the group path has its own case.
    expect(textOf("spec_comments_resolved", { comment_ids: ["four"] })).toBe(
      "resolved 1 spec comment",
    );
  });

  it("names each resolved annotation, not how many there were", () => {
    expect(
      textOf(
        "spec_comments_resolved",
        { comment_ids: [4], paths: ["design.md"] },
        ctxWith(annotation(4)),
      ),
    ).toBe('resolved design.md L42–48 "why not a column?"');
  });

  it("cuts a snippet at sixty characters and skips blank opening lines", () => {
    expect(
      textOf(
        "spec_comments_resolved",
        { comment_ids: [4], paths: ["design.md"] },
        ctxWith(annotation(4, { body: "x".repeat(200) })),
      ),
    ).toBe(`resolved design.md L42–48 "${"x".repeat(60)}…"`);
    expect(
      textOf(
        "spec_comments_resolved",
        { comment_ids: [4], paths: ["design.md"] },
        ctxWith(annotation(4, { body: "\n\n  the   second   line  \nthird" })),
      ),
    ).toBe('resolved design.md L42–48 "the second line"');
  });

  it("falls back to the payload's path, then to the comment id", () => {
    // The listing has not answered (or the annotation is gone): the file is
    // still named, and the link to it is what the next assertion holds on to.
    expect(
      textOf("spec_comments_resolved", {
        comment_ids: [4],
        paths: ["design.md"],
      }),
    ).toBe("resolved design.md");
    expect(
      textOf("spec_comments_resolved", { comment_ids: [4], paths: [] }),
    ).toBe("resolved spec comment #4");
    // An event written before `paths` existed carries no such key at all.
    expect(textOf("spec_comments_resolved", { comment_ids: [4] })).toBe(
      "resolved spec comment #4",
    );
  });

  it("keeps the annotation's anchor through both degrades", async () => {
    // BARE_CTX has no project, and a router Link needs one — so the href is
    // asserted against a context that names the card but holds no listing,
    // which is the degrade the app actually reaches.
    for (const payload of [
      { comment_ids: [4], paths: ["design.md"] },
      { comment_ids: [4], paths: [] },
    ]) {
      const { unmount, findByRole } = renderWithRouter(
        <EventRow
          event={eventOf("spec_comments_resolved", payload)}
          slug="p"
          issueNumber={7}
        />,
      );
      const link = await findByRole("link", {
        name: /design\.md|spec comment/,
      });
      expect(link.getAttribute("href")).toContain("#comment-4");
      unmount();
    }
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
  it("renders a future event as a complete row with its original type and time", async () => {
    // The row destructures renderEvent's result, exactly as on the issue timeline.
    const event = eventOf("future_event" as TimelineEvent["event_type"], {});
    const view = renderWithRouter(<EventRow event={event} />);
    const summary = await view.findByTitle(
      "logged an unknown event: future_event",
    );
    expect(summary.textContent).toBe("logged an unknown event: future_event");
    const time = view.getByTitle(event.created_at);
    expect(time.textContent).toBe(new Date(event.created_at).toLocaleString());
    expect(
      summary.parentElement?.firstElementChild?.querySelector("svg"),
    ).toBeTruthy();
    expect(view.container.textContent).not.toContain("undefined");
  });

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

  // Through the router shim rather than the bare helper above: this is the
  // one case here that renders the row's leading actor chip, and that chip
  // is a link now (T-391).
  it("renders agent actors with their badge in event rows", async () => {
    const { findByTitle, container } = renderWithRouter(
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
    expect((await findByTitle("closed this (Done)")).textContent).toBe(
      "closed this Done",
    );
    expect(container.querySelector('[aria-label="agent"]')).toBeTruthy();
  });

  /**
   * The same shape as the collapsed-summary criterion in
   * timeline-group-render.test.tsx, guarding the twin pair on the event row's
   * own summary span: the two spans share a skeleton, and this row's
   * compensation went unguarded until a copy of it was missing next door,
   * which is how T-416 happened. happy-dom has no layout, so this can only
   * pin the classes down; the browser reading behind them is on that card.
   */
  it("reserves room for the bot badge in the event row summary (T-416)", async () => {
    const { findByTitle } = renderWithRouter(
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
    const summary = await findByTitle("closed this (Done)");
    expect(summary.className).toContain("sm:py-1");
    expect(summary.className).toContain("sm:-my-1");
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

describe("a run of spec resolutions on the page (T-406)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const resolution = (id: number, commentId: number): TimelineEvent => ({
    type: "event",
    id,
    event_type: "spec_comments_resolved",
    actor: user,
    payload: { comment_ids: [commentId], paths: ["design.md"] },
    // Inside one window, one after another: the shape the card reported.
    created_at: `2026-08-11T00:0${id - 1}:00Z`,
    agent_context: {
      agent: "claude-code",
      model: "model-alpha",
      session_id: "session-a",
    },
  });

  /** Timeline fetches served from `page`, with every GET recorded. */
  const stubFetch = (page: TimelinePage, urls: string[]) => {
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET")
        throw new Error(`unexpected fetch: ${method} ${url}`);
      urls.push(url);
      if (/\/issues\/19\/timeline/.test(url)) return Response.json(page);
      if (url.includes("/references/config"))
        return Response.json(DEFAULT_REFERENCE_CONFIG);
      if (url.includes("/spec/comments"))
        return Response.json({ current_version: 2, items: [] });
      return Response.json([]);
    });
  };

  it("draws five resolutions as one group, each row linking its annotation", async () => {
    const events = [1, 2, 3, 4, 5].map((n) => resolution(n, 4600 + n));
    const page: TimelinePage = {
      items: events,
      prev_cursor: null,
      next_cursor: null,
      total_count: events.length,
    };
    const urls: string[] = [];
    stubFetch(page, urls);
    const client = testQueryClient();
    client.setQueryData(issueQuery("p", 19).queryKey, {
      spec_version: 2,
    } as Issue);
    client.setQueryData(specCommentsQuery("p", 19).queryKey, {
      current_version: 2,
      items: events.map((_, i) => annotation(4601 + i)),
    });

    const { container, findByTestId } = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      client,
    );
    await findByTestId("event-group");
    // Steps 3 and 6 can both be right while the page never routes the
    // family — five separate rows is what that failure looks like.
    expect(
      container.querySelectorAll('[data-testid="event-group"]'),
    ).toHaveLength(1);
    const hrefs = [...container.querySelectorAll("ul li a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(
      [1, 2, 3, 4, 5].map((n) => `/projects/p/issues/19#comment-${4600 + n}`),
    );
  });

  it("asks for no annotations on an issue that has no spec", async () => {
    const page: TimelinePage = {
      items: [resolution(1, 4601)],
      prev_cursor: null,
      next_cursor: null,
      total_count: 1,
    };
    const urls: string[] = [];
    stubFetch(page, urls);
    const client = testQueryClient();
    client.setQueryData(issueQuery("p", 19).queryKey, {
      spec_version: null,
    } as Issue);

    const { findByTestId } = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      client,
    );
    await findByTestId("event-group");
    // Reading the `enabled` expression back proves nothing about what
    // mounted: the request and the cache entry are the evidence.
    expect(urls.filter((u) => u.includes("/spec/comments"))).toEqual([]);
    expect(
      client.getQueryData(specCommentsQuery("p", 19).queryKey),
    ).toBeUndefined();
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
    headPage: (url: string) => Response | Promise<Response> = () =>
      Response.json(aPage([1])),
  ) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && /\/projects\/p\/issues\/19\/timeline/.test(url)) {
        calls.push(url);
        return url.includes("last=1") ? tailPage() : headPage(url);
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
    const { findByText, findByRole, getByText } = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      testQueryClient(),
    );
    await findByText(/Couldn't refresh the timeline/);
    expect(getByText("c8")).toBeTruthy();
    const tailCallsBefore = calls.filter((u) => u.includes("last=1")).length;
    expect(tailCallsBefore).toBe(1);
    fireEvent.click(await findByRole("button", { name: "Retry" }));
    // The retried head fetch resolves 500 again; wait for it to land so
    // the call count is settled before comparing.
    await waitFor(() =>
      expect(calls.filter((u) => !u.includes("last=1")).length).toBe(2),
    );
    expect(calls.filter((u) => u.includes("last=1"))).toHaveLength(
      tailCallsBefore,
    );
    expect(getByText("c8")).toBeTruthy();
  });

  it("keeps a cold failure on screen during Retry and renders recovered data", async () => {
    let retryResponse: Promise<Response> | null = null;
    const calls = stubTimeline(
      () =>
        retryResponse ??
        Response.json(
          { error: { code: "internal", message: "cold timeline gone" } },
          { status: 500 },
        ),
    );
    const view = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      testQueryClient(),
    );
    await view.findByText("Failed to load timeline: cold timeline gone");
    expect(view.queryByTestId("timeline-scroll")).toBeNull();

    let resolveRetry: (response: Response) => void = () => undefined;
    retryResponse = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        (view.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      view.getByText("Failed to load timeline: cold timeline gone"),
    ).toBeTruthy();
    await act(async () => {
      resolveRetry(Response.json(aPage([9])));
    });
    await view.findByText("c9");
    expect(view.queryByText(/Failed to load timeline/)).toBeNull();
    expect(calls.filter((u) => u.includes("last=1"))).toHaveLength(2);
    expect(calls.filter((u) => !u.includes("last=1"))).toHaveLength(0);
  });

  it("keeps both 150-comment windows after a failed head expansion and retries that page", async () => {
    const total = 150;
    const tailPage = {
      ...aPage(Array.from({ length: 50 }, (_, i) => i + 101)),
      prev_cursor: "P1",
      total_count: total,
    };
    const headFirst = {
      ...aPage(Array.from({ length: 50 }, (_, i) => i + 1)),
      next_cursor: "H1",
      total_count: total,
    };
    const headSecond = {
      ...aPage(Array.from({ length: 50 }, (_, i) => i + 51)),
      next_cursor: "H2",
      total_count: total,
    };
    let headFails = true;
    const calls = stubTimeline(
      () => Response.json(tailPage),
      (url) => {
        const after = new URL(url, "http://todou.example").searchParams.get(
          "after",
        );
        if (after === "H1") {
          return headFails
            ? Response.json(
                { error: { code: "internal", message: "expanded head gone" } },
                { status: 500 },
              )
            : Response.json(headSecond);
        }
        if (after !== null) throw new Error(`unexpected head cursor: ${after}`);
        return Response.json(headFirst);
      },
    );
    const client = testQueryClient();
    const view = renderWithRouter(
      <Timeline slug="p" issueNumber={19} pendingComments={[]} />,
      client,
    );
    await view.findByText("c1");
    expect(view.getByText("c150")).toBeTruthy();
    expect((await view.findByTestId("fold-block")).textContent).toContain(
      "50 remaining items",
    );

    fireEvent.click(view.getByRole("button", { name: "Load more" }));
    await view.findByText(
      /Couldn't refresh the timeline \(expanded head gone\)/,
    );
    expect(view.queryByText("c100")).toBeNull();
    expect(view.getByText("c1")).toBeTruthy();
    expect(view.getByText("c150")).toBeTruthy();
    expect(view.getByTestId("fold-block")).toBeTruthy();
    expect(calls.filter((u) => u.includes("last=1"))).toHaveLength(1);
    expect(calls.filter((u) => !u.includes("last=1"))).toHaveLength(2);

    headFails = false;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(calls.filter((u) => !u.includes("last=1"))).toHaveLength(3),
    );
    await waitFor(() =>
      expect(view.queryByText(/Couldn't refresh the timeline/)).toBeNull(),
    );
    expect(view.getByText("c1")).toBeTruthy();
    expect(view.getByText("c100")).toBeTruthy();
    expect(view.getByText("c150")).toBeTruthy();
    expect(view.queryByTestId("fold-block")).toBeNull();
    expect(calls.filter((u) => u.includes("last=1"))).toHaveLength(1);
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

describe("user chips in the timeline link to the user page (T-391)", () => {
  const userLinksIn = (el: Element) =>
    [...el.querySelectorAll('a[href^="/users/"]')].map((a) =>
      a.getAttribute("href"),
    );

  it("links a comment's author, and the click lands on their page", async () => {
    const { container, findByText, router } = renderWithRouter(
      <CommentItem
        slug="p"
        issueNumber={1}
        comment={{
          type: "comment",
          id: 1,
          author: user,
          body: "potato",
          component: null,
          created_at: "2026-08-11T00:00:00Z",
          edited_at: null,
          resolved_at: null,
          hidden_at: null,
          agent_context: null,
        }}
      />,
    );
    await findByText("potato");

    // The comment header alone. Asked of the whole comment, an @mention in
    // the body would answer for the author chip and deleting this link would
    // still pass.
    const header = container.querySelector("[data-comment-id='1']")
      ?.firstElementChild as HTMLElement;
    expect(userLinksIn(header)).toEqual(["/users/user"]);

    // "The href is right" and "the click goes somewhere" are two claims.
    // Swap the chip's <Link> for a plain <a href> carrying the same address
    // and every href assertion in this suite still passes while this one
    // reds on `/` — that is the failure it is here for. Unregistering
    // `/users/$ref` from the shim tree does *not* red it: the location moves
    // to an unmatched path just the same.
    fireEvent.click(
      header.querySelector('a[href="/users/user"]') as HTMLAnchorElement,
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/users/user"),
    );
  });

  it("links the event's actor and the person the event names, separately", async () => {
    const { container, findByText } = row(
      "assigned",
      { user: { id: bot.id, login: bot.login } },
      { members: [bot] },
    );
    await findByText("Worker Bot");

    // Two chips on one row, deliberately two different logins: whichever of
    // the two loses its link, this list changes shape. A shared login would
    // let the survivor answer for both.
    expect(userLinksIn(container)).toEqual([
      "/users/user",
      "/users/worker-bot",
    ]);
  });
});
