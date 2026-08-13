import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare, waitFor } from "@testing-library/react";
import type { TimelinePage, UserRef } from "@todou/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
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
  describeEvent,
  EventRow,
} from "../src/components/timeline/event-row.tsx";
import { renderWithProviders as renderWithRouter } from "./render.tsx";

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

describe("describeEvent", () => {
  it("covers the GitHub-style action vocabulary", () => {
    expect(describeEvent("opened", {})).toBe("opened this issue");
    expect(describeEvent("closed", { to: { name: "Done" } })).toBe(
      "closed this (Done)",
    );
    expect(
      describeEvent("status_changed", {
        from: { name: "Todo" },
        to: { name: "In Progress" },
      }),
    ).toBe("moved Todo → In Progress");
    expect(describeEvent("title_changed", { from: "a", to: "b" })).toBe(
      'renamed "a" → "b"',
    );
    expect(describeEvent("label_added", { label: { name: "bug" } })).toBe(
      "added label bug",
    );
    expect(describeEvent("assigned", { user: { login: "worker-bot" } })).toBe(
      "assigned @worker-bot",
    );
    expect(describeEvent("referenced", { by_issue: 7 })).toBe(
      "referenced by #7",
    );
    expect(
      describeEvent("attachment_added", { attachment: { filename: "a.txt" } }),
    ).toBe("attached a.txt");
  });

  it("covers the spec vocabulary (T-23)", () => {
    expect(
      describeEvent("spec_pushed", {
        version: 3,
        message: "address review",
        added: ["extra.md"],
        changed: ["design.md"],
        removed: [],
      }),
    ).toBe("pushed spec v3 (1 added, 1 changed) — address review");
    expect(
      describeEvent("spec_pushed", {
        version: 1,
        message: null,
        added: ["a.md", "b.md"],
        changed: [],
        removed: [],
      }),
    ).toBe("pushed spec v1 (2 added)");
    expect(
      describeEvent("spec_review", {
        version: 3,
        verdict: "approve",
        annotation_count: 0,
      }),
    ).toBe("approved spec v3");
    expect(
      describeEvent("spec_review", {
        version: 3,
        verdict: "request_changes",
        annotation_count: 2,
      }),
    ).toBe("requested changes on spec v3 with 2 comments");
    expect(
      describeEvent("spec_comments_resolved", { comment_ids: [4, 5] }),
    ).toBe("resolved 2 spec comments");
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
    const { getByText, container } = render(
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
    expect(getByText("closed this (Done)")).toBeTruthy();
    expect(container.querySelector('[aria-label="agent"]')).toBeTruthy();
    // Non-referenced rows keep the single-line grid with its tooltip mirror.
    const action = getByText("closed this (Done)");
    expect(action.className).toContain("sm:truncate");
    expect(action.getAttribute("title")).toBe("closed this (Done)");
  });

  it("lets referenced rows wrap instead of truncating (T-99)", () => {
    const { getByText, container } = render(
      <EventRow
        event={{
          type: "event",
          id: 2,
          event_type: "referenced",
          actor: bot,
          payload: { by_issue: 7 },
          created_at: "2026-08-11T00:00:00Z",
          agent_context: null,
        }}
      />,
    );
    const action = getByText("referenced by #7");
    expect(action.className).not.toContain("sm:truncate");
    expect(action.getAttribute("title")).toBeNull();
    expect(container.firstElementChild?.className).toContain("sm:items-start");
  });
});
