import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare, waitFor } from "@testing-library/react";
import type { TimelinePage, UserRef } from "@todou/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import {
  flattenTimeline,
  latestNextCursor,
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
  owner: null,
};

const bot: UserRef = {
  id: 2,
  login: "worker-bot",
  display_name: "Worker Bot",
  kind: "machine",
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
  ): TimelinePage => ({
    items: ids.map((id) => ({
      type: "comment",
      id,
      author: user,
      body: `c${id}`,
      created_at: "2026-08-11T00:00:00Z",
      edited_at: null,
      agent_context: null,
    })),
    prev_cursor: prev,
    next_cursor: next,
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
          created_at: "2026-08-11T00:00:00Z",
          edited_at: null,
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
  });
});
