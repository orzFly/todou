import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { SearchItem, SearchPage } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { referenceConfigQuery } from "../src/api/references.ts";
import {
  domainsOf,
  refShortcut,
  searchPageSchema,
  searchQuery,
} from "../src/api/search.ts";
import { SearchBox } from "../src/components/search-box.tsx";
import { SearchHighlight } from "../src/components/search-highlight.tsx";
import { groupByIssue, SearchResults } from "../src/pages/search.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const status = {
  id: 1,
  name: "Next",
  category: "open" as const,
  color: "#3b82f6",
  position: 1,
  is_default: false,
};

const hit = (over: Partial<SearchItem> = {}): SearchItem => ({
  kind: "issue",
  issue: { number: 141, title: "全文搜索", status },
  comment_id: null,
  spec_path: null,
  field: "title",
  snippet: { text: "增加项目内全文搜索功能", ranges: [[5, 9]] },
  updated_at: "2026-08-30T08:00:00Z",
  ...over,
});

function seeded(page: SearchPage, search: { q?: string; in?: string } = {}) {
  const client = testQueryClient();
  const params = { q: "全文搜索", ...search };
  client.setQueryData(searchQuery("todou", params).queryKey, page);
  client.setQueryData(referenceConfigQuery("todou").queryKey, {
    format: { prefix: "T", history: [] },
    autolinks: [],
  });
  return { client, params };
}

describe("search results", () => {
  it("groups hits under their card and links each one where it lives", async () => {
    const { client, params } = seeded({
      items: [
        hit(),
        hit({
          kind: "comment",
          comment_id: 88,
          field: "body",
          snippet: { text: "实测：全文搜索走 GIN", ranges: [[3, 7]] },
        }),
        hit({
          kind: "spec",
          issue: { number: 99, title: "另一张卡", status },
          spec_path: "design.md",
          field: "body",
          snippet: { text: "全文搜索的定稿", ranges: [[0, 4]] },
        }),
      ],
      has_more: false,
    });
    const { container, findByText } = renderWithProviders(
      <SearchResults slug="todou" search={params} />,
      client,
    );
    await findByText("另一张卡");

    const hrefs = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    // Group headers plus one link per hit — every one a real href, so
    // middle-click and "open in new tab" work (AGENTS: navigation is links).
    expect(hrefs).toContain("/projects/todou/issues/141");
    expect(hrefs).toContain("/projects/todou/issues/141#comment-88");
    expect(hrefs).toContain("/projects/todou/issues/99/spec?file=design.md");
    expect(hrefs.every((h) => h !== null)).toBe(true);
  });

  it("marks the matched run inside the snippet", async () => {
    const { client, params } = seeded({ items: [hit()], has_more: false });
    const { container, findAllByText } = renderWithProviders(
      <SearchResults slug="todou" search={params} />,
      client,
    );
    await findAllByText("全文搜索");
    const marks = [...container.querySelectorAll("mark")].map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(["全文搜索"]);
  });

  it("offers a direct jump when the query names a card", async () => {
    const { client } = seeded({ items: [], has_more: false }, { q: "T-141" });
    const { findByText } = renderWithProviders(
      <SearchResults slug="todou" search={{ q: "T-141" }} />,
      client,
    );
    const link = await findByText("Go to T-141");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "/projects/todou/issues/141",
    );
  });

  it("says so when nothing matched", async () => {
    const { client, params } = seeded({ items: [], has_more: false });
    const { findByText } = renderWithProviders(
      <SearchResults slug="todou" search={params} />,
      client,
    );
    await findByText(/Nothing matched/);
  });
});

/**
 * A router of its own, because what the box does is navigate — and the
 * shared shim's memory history leaves `window.location` untouched, so
 * reading the router back is the only way to see where it went.
 */
function renderBox() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SearchBox slug="todou" />,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const searchRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "search",
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <SearchBox slug="todou" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectRoute.addChildren([searchRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = testQueryClient();
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    ...utils,
    where: () => ({
      pathname: router.state.location.pathname,
      search: router.state.location.search,
    }),
  };
}

function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("no search form rendered");
  fireEvent.submit(form);
}

describe("SearchBox", () => {
  it("submits to the results page, trimming what it sends", async () => {
    const { container, findByLabelText, where } = renderBox();
    const input = (await findByLabelText(
      "Search this project",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  中文分词  " } });
    submit(container);
    await waitFor(() =>
      expect(where()).toEqual({
        pathname: "/projects/todou/search",
        search: { q: "中文分词" },
      }),
    );
  });

  it("does not navigate on an empty query", async () => {
    const { container, findByLabelText, where } = renderBox();
    await findByLabelText("Search this project");
    submit(container);
    fireEvent.change(await findByLabelText("Search this project"), {
      target: { value: "   " },
    });
    submit(container);
    expect(where().pathname).toBe("/");
  });

  it("takes focus on `/`", async () => {
    const { findByLabelText } = renderBox();
    const input = await findByLabelText("Search this project");
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: "/" });
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("leaves `/` alone while another field has focus", async () => {
    const { findByLabelText } = renderBox();
    const input = await findByLabelText("Search this project");
    const other = document.createElement("textarea");
    document.body.append(other);
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(input);
    other.remove();
  });
});

describe("SearchHighlight", () => {
  it("skips a range the previous one already covered", async () => {
    // Two terms hitting the same run — painting the second from behind the
    // cursor would emit the overlap twice.
    const { container } = renderWithProviders(
      <SearchHighlight
        snippet={{
          text: "searching",
          ranges: [
            [0, 9],
            [0, 6],
          ],
        }}
      />,
    );
    await waitFor(() => expect(container.textContent).toBe("searching"));
    expect(container.querySelectorAll("mark")).toHaveLength(1);
  });

  it("renders unmatched text as-is", async () => {
    const { container } = renderWithProviders(
      <SearchHighlight snippet={{ text: "plain", ranges: [] }} />,
    );
    await waitFor(() => expect(container.textContent).toBe("plain"));
    expect(container.querySelector("mark")).toBeNull();
  });
});

describe("refShortcut", () => {
  it("takes the project's own spelling, and a bare number", () => {
    expect(refShortcut("T-141", "T")).toBe(141);
    expect(refShortcut("t-141", "T")).toBe(141);
    expect(refShortcut(" 141 ", "T")).toBe(141);
    expect(refShortcut("#141", null)).toBe(141);
  });

  it("stays out of the way of an ordinary query", () => {
    expect(refShortcut("全文搜索", "T")).toBeUndefined();
    expect(refShortcut("T-141 搜索", "T")).toBeUndefined();
    expect(refShortcut("0", "T")).toBeUndefined();
    expect(refShortcut("", "T")).toBeUndefined();
  });
});

describe("groupByIssue", () => {
  it("keeps a card where its best hit ranked", () => {
    const groups = groupByIssue([
      hit({ issue: { number: 2, title: "b", status } }),
      hit({ issue: { number: 1, title: "a", status } }),
      hit({
        issue: { number: 2, title: "b", status },
        kind: "comment",
        comment_id: 5,
      }),
    ]);
    expect(groups.map((g) => g.issue.number)).toEqual([2, 1]);
    expect(groups[0]?.hits).toHaveLength(2);
  });
});

describe("search params", () => {
  it("accepts only the three domains, in any combination", () => {
    expect(searchPageSchema.parse({ in: "issues,specs" }).in).toBe(
      "issues,specs",
    );
    expect(searchPageSchema.safeParse({ in: "events" }).success).toBe(false);
    expect(domainsOf({ in: "comments,specs" })).toEqual(["comments", "specs"]);
    expect(domainsOf({})).toEqual([]);
  });

  it("survives a query the router already read as a number", () => {
    // `?q=141` — a pasted card number, which is the case refShortcut exists
    // for — reaches validateSearch as a number, and a bare z.string() there
    // throws the whole route away instead of rendering the page.
    expect(searchPageSchema.parse({ q: 141 }).q).toBe("141");
    expect(searchPageSchema.parse({ status: 3 }).status).toBe("3");
    expect(searchPageSchema.parse({}).q).toBeUndefined();
  });
});
