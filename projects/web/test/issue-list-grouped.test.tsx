import { fireEvent, waitFor } from "@testing-library/react";
import type {
  IssueCounts,
  IssueListItem,
  IssueListPage as IssueListPageData,
  Status,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupedIssueList, groupStatuses } from "../src/pages/issue-list.tsx";
import { renderWithProviders } from "./render.tsx";

const backlog: Status = {
  id: 1,
  name: "Backlog",
  category: "open",
  color: "#666666",
  position: 0,
  is_default: false,
};
const todo: Status = {
  id: 2,
  name: "Todo",
  category: "open",
  color: "#123456",
  position: 1,
  is_default: true,
};
const ship: Status = {
  id: 5,
  name: "Ready to Ship",
  category: "open",
  color: "#f59e0b",
  position: 4,
  is_default: false,
};
const done: Status = {
  id: 9,
  name: "Done",
  category: "closed",
  color: "#22c55e",
  position: 6,
  is_default: false,
};
const statuses = [backlog, todo, ship, done];

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
    unread: false,
    unread_comments: 0,
  };
}

/** Serve GET /issues from a (status, cursor) → page map; the rest 404s. */
function fakeGroupServer(
  pages: Record<string, Record<string, IssueListPageData>>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test");
    const status = url.searchParams.get("status") ?? "";
    const cursor = url.searchParams.get("cursor") ?? "";
    const page = pages[status]?.[cursor];
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

describe("groupStatuses", () => {
  const counts: IssueCounts = {
    open: 4,
    closed: 3,
    by_status: { "1": 0, "2": 1, "5": 3, "9": 3 },
  };

  it("keeps only open statuses with matches, later stages first", () => {
    expect(groupStatuses(statuses, counts, undefined)).toEqual([ship, todo]);
  });

  it("narrows to the URL's multi-status selection", () => {
    expect(groupStatuses(statuses, counts, [todo.id, done.id])).toEqual([todo]);
  });
});

describe("GroupedIssueList", () => {
  const counts: IssueCounts = {
    open: 3,
    closed: 1,
    by_status: { "2": 1, "5": 2, "9": 1 },
  };

  it("renders one section per non-empty open group and paginates within it", async () => {
    vi.stubGlobal(
      "fetch",
      fakeGroupServer({
        "5": {
          "": { items: [item(51, "ship one", ship)], next_cursor: "c5" },
          c5: { items: [item(52, "ship two", ship)], next_cursor: null },
        },
        "2": { "": { items: [item(21, "todo one", todo)], next_cursor: null } },
      }),
    );

    const { container, findByText, queryByText } = renderWithProviders(
      <GroupedIssueList
        slug="p"
        statuses={statuses}
        counts={counts}
        allLabels={[]}
        search={{}}
      />,
    );

    await findByText("ship one");
    await findByText("todo one");
    // Later pipeline stages first; Backlog (0 matches) and Done (closed)
    // never render as groups.
    const sections = [...container.querySelectorAll("section")].map((s) =>
      s.getAttribute("aria-label"),
    );
    expect(sections).toEqual(["Ready to Ship", "Todo"]);
    expect(queryByText("Backlog")).toBeNull();
    expect(queryByText("Done")).toBeNull();

    fireEvent.click(await findByText("Show 1 more…"));
    await findByText("ship two");
    await waitFor(() => {
      expect(queryByText(/Show \d+ more/)).toBeNull();
    });
  });

  it("shows the empty state when every group is empty", async () => {
    vi.stubGlobal("fetch", fakeGroupServer({}));
    const { findByText } = renderWithProviders(
      <GroupedIssueList
        slug="p"
        statuses={statuses}
        counts={{ open: 0, closed: 0, by_status: {} }}
        allLabels={[]}
        search={{}}
      />,
    );
    expect(await findByText(/地里很干净/)).toBeTruthy();
  });
});
