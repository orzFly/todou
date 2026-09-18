import { act, fireEvent, waitFor } from "@testing-library/react";
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
    muted: null,
    blocked_by: [],
    blocks: [],
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it("keeps loaded rows and replaces Load more after an append failure", async () => {
    const page1: IssueListPageData = {
      items: [item(1, "first", open)],
      next_cursor: "c1",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test");
        return new Response("{}", {
          status: url.pathname.endsWith("/issues") ? 500 : 404,
        });
      }),
    );

    const view = renderWithProviders(
      <IssueList
        slug="p"
        page={page1}
        statuses={[open, done]}
        allLabels={[]}
        search={{}}
      />,
    );

    fireEvent.click(await view.findByText("Load more"));

    // The retained row matters: this must be an append failure, not a cold
    // failure that replaces the content already on screen.
    expect(await view.findByText(/Could not load more/)).toBeTruthy();
    expect(view.getByText("first")).toBeTruthy();
    expect(view.queryByText("Load more")).toBeNull();
  });

  it("recovers a failed append through Retry", async () => {
    const page1: IssueListPageData = {
      items: [item(1, "first", open)],
      next_cursor: "c1",
    };
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test");
        if (!url.pathname.endsWith("/issues")) {
          return new Response("{}", { status: 404 });
        }
        if (failing) return new Response("{}", { status: 500 });
        return new Response(
          JSON.stringify({
            items: [item(2, "second", open)],
            next_cursor: "c2",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const view = renderWithProviders(
      <IssueList
        slug="p"
        page={page1}
        statuses={[open, done]}
        allLabels={[]}
        search={{}}
      />,
    );

    fireEvent.click(await view.findByText("Load more"));
    expect(await view.findByText(/Could not load more/)).toBeTruthy();

    failing = false;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(await view.findByText("second")).toBeTruthy();
    expect(view.queryByText(/Could not load more/)).toBeNull();
    expect(view.getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("moves focus to Retry when the append control is replaced", async () => {
    const page1: IssueListPageData = {
      items: [item(1, "first", open)],
      next_cursor: "c1",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test");
        return new Response("{}", {
          status: url.pathname.endsWith("/issues") ? 500 : 404,
        });
      }),
    );

    const view = renderWithProviders(
      <IssueList
        slug="p"
        page={page1}
        statuses={[open, done]}
        allLabels={[]}
        search={{}}
      />,
    );

    fireEvent.click(await view.findByText("Load more"));
    const retry = await view.findByRole("button", { name: "Retry" });
    expect(document.activeElement).toBe(retry);
  });

  it("keeps search focus when an existing failure remounts after narrowing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test");
        return new Response("{}", {
          status: url.pathname.endsWith("/issues") ? 500 : 404,
        });
      }),
    );

    function Harness() {
      const [typed, setTyped] = useState("");
      return (
        <>
          <input
            aria-label="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <IssueList
            slug="p"
            page={{ items: [item(1, "first", open)], next_cursor: "c1" }}
            statuses={[open, done]}
            allLabels={[]}
            search={{}}
            typed={typed}
            narrowing={typed.trim() !== ""}
          />
        </>
      );
    }

    const view = renderWithProviders(<Harness />);
    fireEvent.click(await view.findByText("Load more"));
    const retry = await view.findByRole("button", { name: "Retry" });
    expect(document.activeElement).toBe(retry);

    const search = view.getByRole("textbox", { name: "search" });
    search.focus();
    // Both edits happen before a debounced URL update: resetKey stays fixed,
    // while the actual narrowing gate unmounts and remounts the failure.
    fireEvent.change(search, { target: { value: "f" } });
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.activeElement).toBe(search);
  });

  it("clears an append failure when the filter state changes", async () => {
    // This is a state-reset guard, not standalone regression evidence: the
    // old tree had no append failure UI, so reverting the feature cannot make
    // this test red by itself.
    const closedPage1: IssueListPageData = {
      items: [item(11, "done one", done)],
      next_cursor: "c1",
    };
    const openPage1: IssueListPageData = {
      items: [item(21, "open one", open)],
      next_cursor: "open-c1",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test");
        return new Response("{}", {
          status: url.pathname.endsWith("/issues") ? 500 : 404,
        });
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

    const view = renderWithProviders(<Harness />);
    fireEvent.click(await view.findByText("Load more"));
    expect(await view.findByText(/Could not load more/)).toBeTruthy();

    fireEvent.click(view.getByText("switch to open"));
    await view.findByText("open one");
    await waitFor(() =>
      expect(view.queryByText(/Could not load more/)).toBeNull(),
    );
    expect(view.getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("appends an in-flight page only once when Load more is clicked twice", async () => {
    const page1: IssueListPageData = {
      items: [item(1, "first", open)],
      next_cursor: "c1",
    };
    const request = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test");
        if (!url.pathname.endsWith("/issues")) {
          return new Response("{}", { status: 404 });
        }
        await request.promise;
        return new Response(
          JSON.stringify({
            items: [item(2, "second", open)],
            next_cursor: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const view = renderWithProviders(
      <IssueList
        slug="p"
        page={page1}
        statuses={[open, done]}
        allLabels={[]}
        search={{}}
      />,
    );

    const loadMore = await view.findByText("Load more");
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);
    await act(async () => {
      request.resolve();
    });
    await waitFor(() =>
      expect(view.queryAllByText("second").length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(view.queryByText("Load more")).toBeNull());

    // fetchQuery already coalesces the network request, so request counts
    // cannot catch two await continuations appending the same page.
    expect(view.getAllByText("second")).toHaveLength(1);
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

  it("discards an in-flight page when the filter state changes", async () => {
    const closedPage1: IssueListPageData = {
      items: [item(11, "done one", done)],
      next_cursor: "c1",
    };
    const openPage1: IssueListPageData = {
      items: [item(21, "open one", open)],
      next_cursor: null,
    };
    const request = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test");
        if (!url.pathname.endsWith("/issues")) {
          return new Response("{}", { status: 404 });
        }
        await request.promise;
        return new Response(
          JSON.stringify({
            items: [item(12, "done two", done)],
            next_cursor: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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

    const view = renderWithProviders(<Harness />);
    fireEvent.click(await view.findByText("Load more"));
    fireEvent.click(view.getByText("switch to open"));
    await view.findByText("open one");
    await act(async () => {
      request.resolve();
    });

    // Both filters have one first-page row, so a row-count assertion is
    // green with or without the bug. The old filter's concrete title is not.
    expect(view.queryByText("done two")).toBeNull();
  });

  it("discards an in-flight page after the same filter is revisited", async () => {
    const closedPage1: IssueListPageData = {
      items: [item(11, "done one", done)],
      next_cursor: "c1",
    };
    const openPage1: IssueListPageData = {
      items: [item(21, "open one", open)],
      next_cursor: null,
    };
    const request = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://test");
        if (!url.pathname.endsWith("/issues")) {
          return new Response("{}", { status: 404 });
        }
        await request.promise;
        return new Response(
          JSON.stringify({
            items: [item(12, "old closed page", done)],
            next_cursor: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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
          <button type="button" onClick={() => setCategory("closed")}>
            switch to closed
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

    const view = renderWithProviders(<Harness />);
    fireEvent.click(await view.findByText("Load more"));
    fireEvent.click(view.getByText("switch to open"));
    await view.findByText("open one");
    fireEvent.click(view.getByText("switch to closed"));
    await view.findByText("done one");
    await act(async () => {
      request.resolve();
    });

    expect(view.queryByText("old closed page")).toBeNull();
  });
});
