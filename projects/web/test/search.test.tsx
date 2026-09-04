import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type {
  Autolink,
  IssueListItem,
  Project,
  ReferenceDirectory,
  SearchItem,
  SearchPage,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { projectQuery, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { domainsOf, searchPageSchema, searchQuery } from "../src/api/search.ts";
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

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status,
  author: {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-08-30T08:00:00Z",
  updated_at: "2026-08-30T08:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
});

const DIRECTORY: ReferenceDirectory = {
  since: "2020-01-01T00:00:00.000Z",
  entries: [
    { prefix: "M", slug: "mirror", from: "2020-01-01T00:00:00.000Z", to: null },
  ],
  contested: [],
};

/**
 * Everything a jump offer reads before it can resolve anything: this
 * project's format, the prefix directory, and the projects the viewer may
 * name. Without all three the offer stays empty by design, so a test about
 * a jump has to seed all three.
 */
function seedJumpContext(client: QueryClient, autolinks: Autolink[] = []) {
  client.setQueryData(referenceConfigQuery("todou").queryKey, {
    format: { prefix: "T", history: [] },
    autolinks,
  });
  client.setQueryData(referenceConfigQuery("mirror").queryKey, {
    format: { prefix: "M", history: [] },
    autolinks: [],
  });
  client.setQueryData(referenceDirectoryQuery.queryKey, DIRECTORY);
  client.setQueryData(
    projectsQuery.queryKey,
    ["todou", "mirror"].map(
      (slug): Project => ({
        id: 1,
        slug,
        name: slug === "todou" ? "Todou" : "Mirror",
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  return client;
}

function seeded(page: SearchPage, search: { q?: string; in?: string } = {}) {
  const client = seedJumpContext(testQueryClient());
  const params = { q: "全文搜索", ...search };
  client.setQueryData(searchQuery("todou", params).queryKey, page);
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

  it("offers a direct jump to the card the query names", async () => {
    const { client } = seeded({ items: [], has_more: false }, { q: "T-141" });
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const { findByText } = renderWithProviders(
      <SearchResults slug="todou" search={{ q: "T-141" }} />,
      client,
    );
    const link = (await findByText("T-141")).closest("a");
    expect(link?.getAttribute("href")).toBe("/projects/todou/issues/141");
    expect(link?.textContent).toContain("全文搜索");
    expect(link?.textContent).toContain("Next");
  });

  it("offers nothing when there is no such card", async () => {
    // Which is also what an unreadable project and a trashed card look
    // like — the reader learns nothing either way (T-150).
    const { client } = seeded({ items: [], has_more: false }, { q: "T-141" });
    client.setQueryData(issueRefQuery("todou", 141).queryKey, null);
    const { findByText, queryByText } = renderWithProviders(
      <SearchResults slug="todou" search={{ q: "T-141" }} />,
      client,
    );
    await findByText(/Nothing matched/);
    expect(queryByText("T-141")).toBeNull();
  });

  it("spells a jump across projects so it cannot read as one of ours", async () => {
    const { client } = seeded(
      { items: [], has_more: false },
      { q: "mirror#3" },
    );
    client.setQueryData(
      issueRefQuery("mirror", 3).queryKey,
      refItem(3, "Theirs"),
    );
    const { findByText } = renderWithProviders(
      <SearchResults slug="todou" search={{ q: "mirror#3" }} />,
      client,
    );
    const link = (await findByText("mirror/M-3")).closest("a");
    expect(link?.getAttribute("href")).toBe("/projects/mirror/issues/3");
  });

  it("offers the external tracker an autolink prefix points at", async () => {
    const { client } = seeded({ items: [], has_more: false }, { q: "GH-76" });
    seedJumpContext(client, [
      {
        id: 1,
        prefix: "GH-",
        url_template: "https://github.com/o/r/issues/<num>",
      },
    ]);
    const { findByText } = renderWithProviders(
      <SearchResults slug="todou" search={{ q: "GH-76" }} />,
      client,
    );
    const link = (await findByText("GH-76")).closest("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/o/r/issues/76");
    expect(link?.getAttribute("target")).toBe("_blank");
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
function renderBox(
  client: QueryClient = testQueryClient(),
  { boxes = 1, onEscape }: { boxes?: number; onEscape?: () => void } = {},
) {
  const rootRoute = createRootRoute();
  // Two is the real header: the wide row's box and the narrow row's.
  const Boxes = () => (
    <>
      <SearchBox slug="todou" onEscape={onEscape} />
      {boxes > 1 && <SearchBox slug="todou" listAlign="stretch" />}
    </>
  );
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Boxes,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const searchRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "search",
    validateSearch: (search: Record<string, unknown>) => search,
    component: Boxes,
  });
  // The box now navigates to a card as well, and the router refuses a
  // destination its tree does not know.
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: Boxes,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectRoute.addChildren([searchRoute, issueRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
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

/** The box only offers anything while it has focus, so a test has to give it some. */
async function typeInto(
  utils: Awaited<ReturnType<typeof renderBox>>,
  value: string,
): Promise<HTMLInputElement> {
  const input = (await utils.findByLabelText(
    "Search this project",
  )) as HTMLInputElement;
  input.focus();
  fireEvent.focusIn(input);
  fireEvent.change(input, { target: { value } });
  return input;
}

const optionsOf = (container: HTMLElement) => [
  ...container.querySelectorAll('[role="option"]'),
];

const listboxOf = (container: HTMLElement) =>
  container.querySelector('[role="listbox"]');

function seedBox(autolinks: Autolink[] = []): QueryClient {
  const client = seedJumpContext(testQueryClient(), autolinks);
  client.setQueryData(projectQuery("todou").queryKey, {
    id: 1,
    slug: "todou",
    name: "Todou",
    description: "",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  return client;
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

describe("SearchBox · the jump offer", () => {
  it("offers the card a ref names, and Enter follows it", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client);
    await typeInto(utils, "T-141");

    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(2));
    const [card, search] = optionsOf(utils.container);
    expect(card?.getAttribute("href")).toBe("/projects/todou/issues/141");
    expect(card?.textContent).toContain("T-141");
    expect(card?.textContent).toContain("全文搜索");
    expect(card?.textContent).toContain("Next");
    expect(card?.getAttribute("aria-selected")).toBe("true");
    expect(search?.textContent).toContain("Search for “T-141”");

    submit(utils.container);
    await waitFor(() =>
      expect(utils.where().pathname).toBe("/projects/todou/issues/141"),
    );
  });

  it("searches for the ref as text when the reader arrows past the card", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client);
    const input = await typeInto(utils, "T-141");
    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(2));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    submit(utils.container);
    await waitFor(() =>
      expect(utils.where()).toEqual({
        pathname: "/projects/todou/search",
        search: { q: "T-141" },
      }),
    );
  });

  it("closes on Escape and stays closed until the query changes", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    client.setQueryData(
      issueRefQuery("todou", 1411).queryKey,
      refItem(1411, "另一张"),
    );
    const utils = renderBox(client);
    const input = await typeInto(utils, "T-141");
    await waitFor(() => expect(listboxOf(utils.container)).not.toBeNull());

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(listboxOf(utils.container)).toBeNull());

    fireEvent.change(input, { target: { value: "T-1411" } });
    await waitFor(() => expect(listboxOf(utils.container)).not.toBeNull());
  });

  it("searches after Escape, so hiding the offer means something", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client);
    const input = await typeInto(utils, "T-141");
    await waitFor(() => expect(listboxOf(utils.container)).not.toBeNull());

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(listboxOf(utils.container)).toBeNull());
    submit(utils.container);
    await waitFor(() =>
      expect(utils.where()).toEqual({
        pathname: "/projects/todou/search",
        search: { q: "T-141" },
      }),
    );
  });

  it("reaches the card even when Enter beats the context it needs", async () => {
    // The box asks nothing until it is typed in, so a reader who pastes and
    // hits Enter in one beat submits before the project's own format has
    // arrived. Reading that as "not a reference" would make the destination
    // a function of the network.
    const client = seedBox();
    let land: (directory: ReferenceDirectory) => void = () => {};
    const deferred = new Promise<ReferenceDirectory>((resolve) => {
      land = resolve;
    });
    client.removeQueries({ queryKey: referenceDirectoryQuery.queryKey });
    void client.prefetchQuery({
      ...referenceDirectoryQuery,
      queryFn: () => deferred,
    });
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client);
    await typeInto(utils, "T-141");
    // Nothing on offer yet — the context has not landed.
    expect(listboxOf(utils.container)).toBeNull();
    submit(utils.container);

    land(DIRECTORY);
    await waitFor(() =>
      expect(utils.where().pathname).toBe("/projects/todou/issues/141"),
    );
  });

  it("offers nothing, and searches as ever, when there is no such card", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    client.setQueryData(issueRefQuery("todou", 999).queryKey, null);
    const utils = renderBox(client);
    // Opened on a card that is there, so the listbox going away is the
    // absence of a card rather than a query that never answered.
    const input = await typeInto(utils, "T-141");
    await waitFor(() => expect(listboxOf(utils.container)).not.toBeNull());

    fireEvent.change(input, { target: { value: "T-999" } });
    await waitFor(() => expect(listboxOf(utils.container)).toBeNull());

    submit(utils.container);
    await waitFor(() =>
      expect(utils.where()).toEqual({
        pathname: "/projects/todou/search",
        search: { q: "T-999" },
      }),
    );
  });

  it("waits for a lookup in flight rather than guessing where Enter goes", async () => {
    const client = seedBox();
    let land: (item: IssueListItem | null) => void = () => {};
    const deferred = new Promise<IssueListItem | null>((resolve) => {
      land = resolve;
    });
    void client.prefetchQuery({
      ...issueRefQuery("todou", 141),
      queryFn: () => deferred,
    });
    const utils = renderBox(client);
    const input = await typeInto(utils, "T-141");
    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(2));
    // A placeholder, not a link: there is nothing to point at yet.
    const [placeholder] = optionsOf(utils.container);
    expect(placeholder?.tagName).toBe("DIV");
    expect(placeholder?.getAttribute("aria-selected")).toBe("true");

    // Pasting and hitting Enter in the same beat must reach the same place
    // as waiting for the row first — the destination is not the network's
    // to decide.
    submit(utils.container);
    await waitFor(() => expect(input.getAttribute("aria-busy")).toBe("true"));
    expect(utils.where().pathname).toBe("/");

    land(refItem(141, "全文搜索"));
    await waitFor(() =>
      expect(utils.where().pathname).toBe("/projects/todou/issues/141"),
    );
  });

  it("falls back to searching when the awaited card turns out missing", async () => {
    const client = seedBox();
    let land: (item: IssueListItem | null) => void = () => {};
    const deferred = new Promise<IssueListItem | null>((resolve) => {
      land = resolve;
    });
    void client.prefetchQuery({
      ...issueRefQuery("todou", 141),
      queryFn: () => deferred,
    });
    const utils = renderBox(client);
    const input = await typeInto(utils, "T-141");
    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(2));
    submit(utils.container);
    await waitFor(() => expect(input.getAttribute("aria-busy")).toBe("true"));
    expect(utils.where().pathname).toBe("/");

    land(null);
    await waitFor(() =>
      expect(utils.where()).toEqual({
        pathname: "/projects/todou/search",
        search: { q: "T-141" },
      }),
    );
  });

  it("names the project in both the jump and the search row when the card is elsewhere", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("mirror", 3).queryKey,
      refItem(3, "Theirs"),
    );
    const utils = renderBox(client);
    await typeInto(utils, "mirror#3");
    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(2));
    const [card, search] = optionsOf(utils.container);
    expect(card?.textContent).toContain("mirror/M-3");
    expect(card?.getAttribute("href")).toBe("/projects/mirror/issues/3");
    // Without this the reader cannot tell the search will stay here.
    expect(search?.textContent).toContain("in Todou");
  });

  it("opens an autolink's target in a new tab", async () => {
    const client = seedBox([
      {
        id: 1,
        prefix: "GH-",
        url_template: "https://github.com/o/r/issues/<num>",
      },
    ]);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const utils = renderBox(client);
    await typeInto(utils, "GH-76");
    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(2));
    const [external] = optionsOf(utils.container);
    expect(external?.getAttribute("href")).toBe(
      "https://github.com/o/r/issues/76",
    );
    expect(external?.getAttribute("target")).toBe("_blank");
    expect(external?.getAttribute("rel")).toBe("noreferrer");

    submit(utils.container);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://github.com/o/r/issues/76",
        "_blank",
        "noreferrer",
      ),
    );
    // Opening a tab is not leaving this page.
    expect(utils.where().pathname).toBe("/");
    open.mockRestore();
  });

  it("offers both readings of #76 when # is also the autolink prefix", async () => {
    // docs/external-trackers.md's recommended mirror setup, where the two
    // are equally plausible and picking one for the reader is a guess.
    const client = seedBox([
      {
        id: 1,
        prefix: "#",
        url_template: "https://github.com/o/r/issues/<num>",
      },
    ]);
    client.setQueryData(
      issueRefQuery("todou", 76).queryKey,
      refItem(76, "Ours"),
    );
    const utils = renderBox(client);
    await typeInto(utils, "#76");
    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(3));
    const [card, external] = optionsOf(utils.container);
    expect(card?.getAttribute("href")).toBe("/projects/todou/issues/76");
    expect(card?.getAttribute("aria-selected")).toBe("true");
    expect(external?.getAttribute("href")).toBe(
      "https://github.com/o/r/issues/76",
    );
  });

  it("highlights the external link when there is no card behind #76", async () => {
    const client = seedBox([
      {
        id: 1,
        prefix: "#",
        url_template: "https://github.com/o/r/issues/<num>",
      },
    ]);
    client.setQueryData(issueRefQuery("todou", 76).queryKey, null);
    const utils = renderBox(client);
    await typeInto(utils, "#76");
    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(2));
    const [external] = optionsOf(utils.container);
    expect(external?.getAttribute("href")).toBe(
      "https://github.com/o/r/issues/76",
    );
    expect(external?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the first Escape for the offer it closes", async () => {
    const onEscape = vi.fn();
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client, { onEscape });
    const input = await typeInto(utils, "T-141");
    await waitFor(() => expect(listboxOf(utils.container)).not.toBeNull());

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(listboxOf(utils.container)).toBeNull());
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("hands Escape to its host once there is no offer left", async () => {
    const onEscape = vi.fn();
    const utils = renderBox(seedBox(), { onEscape });
    const input = await typeInto(utils, "plain words");
    expect(listboxOf(utils.container)).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("gives the header's two boxes listboxes of their own", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client, { boxes: 2 });
    // Both are mounted at once in the real header (wide row and narrow
    // row), so a written id would be on the page twice.
    const inputs = await utils.findAllByLabelText("Search this project");
    const ids = inputs.map((input) => input.getAttribute("aria-controls"));
    expect(new Set(ids).size).toBe(2);
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
    // `?q=141` — a pasted card number, the very case the jump offer exists
    // for — reaches validateSearch as a number, and a bare z.string() there
    // throws the whole route away instead of rendering the page.
    expect(searchPageSchema.parse({ q: 141 }).q).toBe("141");
    expect(searchPageSchema.parse({ status: 3 }).status).toBe("3");
    expect(searchPageSchema.parse({}).q).toBeUndefined();
  });
});
