import { fireEvent, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  IssueListPage as IssueListPageData,
  Status,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueSearch } from "../src/api/issues.ts";
import { IssueList } from "../src/pages/issue-list.tsx";
import { renderWithProviders } from "./render.tsx";

const open: Status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#123456",
  position: 0,
  is_default: true,
};
const done: Status = {
  id: 2,
  name: "Done",
  category: "closed",
  color: "#654321",
  position: 1,
  is_default: false,
};

function item(id: number, title: string, status: Status): IssueListItem {
  return {
    id,
    number: id,
    title,
    status,
    author: {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    assignees: [],
    labels: [],
    created_at: "2026-08-11T00:00:00Z",
    updated_at: "2026-08-11T00:00:00Z",
    body_edited_at: null,
    open_questions: 0,
    spec_version: null,
    spec_review_status: null,
    spec_unresolved_comments: 0,
    deleted_at: null,
    deleted_by: null,
    unread: false,
    unread_comments: 0,
    moves: [],
  };
}

/** Serve GET /issues from a cursor → page map; everything else 404s. */
function fakeListServer(pages: Record<string, IssueListPageData>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test");
    const cursor = url.searchParams.get("cursor") ?? "";
    const page = pages[cursor];
    if (!url.pathname.endsWith("/issues") || !page) {
      return new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issue list Load More pagination state", () => {
  it("drops the button at the end instead of reusing page 1's cursor", async () => {
    // T-78: the last fetched page's null next_cursor must not fall back to
    // the first page's cursor — that resurrects the button and re-appends
    // page 2 on every further click, forever.
    const page1: IssueListPageData = {
      items: [item(1, "first", open)],
      next_cursor: "c1",
    };
    vi.stubGlobal(
      "fetch",
      fakeListServer({
        c1: { items: [item(2, "second", open)], next_cursor: null },
      }),
    );

    const { getByText, queryByText, findByText } = renderWithProviders(
      <IssueList
        slug="p"
        page={page1}
        statuses={[open, done]}
        allLabels={[]}
        search={{}}
      />,
    );

    fireEvent.click(await findByText("Load more"));
    await findByText("second");
    expect(getByText("first")).toBeTruthy();
    expect(queryByText("Load more")).toBeNull();
  });

  it("discards loaded pages when the filter state changes", async () => {
    // T-78: pages appended under ?category=closed lingered after switching
    // to Open, so Done rows showed in the open list.
    const closedPage1: IssueListPageData = {
      items: [item(11, "done one", done)],
      next_cursor: "c1",
    };
    const openPage1: IssueListPageData = {
      items: [item(21, "open one", open)],
      next_cursor: null,
    };
    vi.stubGlobal(
      "fetch",
      fakeListServer({
        c1: { items: [item(12, "done two", done)], next_cursor: null },
      }),
    );

    function Harness() {
      const [category, setCategory] = useState<"closed" | "open">("closed");
      const search: IssueSearch =
        category === "closed" ? { category: "closed" } : {};
      return (
        <>
          <button type="button" onClick={() => setCategory("open")}>
            switch to open
          </button>
          <IssueList
            slug="p"
            page={category === "closed" ? closedPage1 : openPage1}
            statuses={[open, done]}
            allLabels={[]}
            search={search}
          />
        </>
      );
    }

    const { getByText, queryByText, findByText } = renderWithProviders(
      <Harness />,
    );

    fireEvent.click(await findByText("Load more"));
    await findByText("done two");

    fireEvent.click(getByText("switch to open"));
    await findByText("open one");
    await waitFor(() => {
      expect(queryByText("done one")).toBeNull();
      expect(queryByText("done two")).toBeNull();
    });
  });
});
