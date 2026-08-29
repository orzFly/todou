import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare, waitFor } from "@testing-library/react";
import type {
  Label,
  Status,
  TimelineEvent,
  TimelinePage,
  UserRef,
} from "@todou/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
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
