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
import { recentOpenIssuesQuery } from "../src/api/issues.ts";
import {
  labelsQuery,
  membersQuery,
  projectQuery,
  projectsQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { PROJECT_PEEK } from "../src/api/ref-jump.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import {
  domainsOf,
  type SearchPageSearch,
  searchFacetsQuery,
  searchPageSchema,
  searchQuery,
  withDomains,
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
  moves: [],
});

const DIRECTORY: ReferenceDirectory = {
  entries: [
    { prefix: "M", slug: "mirror", from: "2020-01-01T00:00:00.000Z", to: null },
    // Every prefix the viewer may see, their own project's included — which
    // is what the server sends, and what the completion pool is built from.
    { prefix: "T", slug: "todou", from: "2020-01-01T00:00:00.000Z", to: null },
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

function seeded(
  page: Omit<SearchPage, "diagnostics"> &
    Partial<Pick<SearchPage, "diagnostics">>,
  search: { q?: string; in?: string } = {},
) {
  const client = seedJumpContext(testQueryClient());
  const params = { q: "全文搜索", ...search };
  client.setQueryData(searchQuery("todou", params).queryKey, {
    diagnostics: [],
    ...page,
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

  it("offers the project's home when a shared link names one", async () => {
    // `?q=M-` is where the box's own offer lands when it is shared, so the
    // page has to make the same offer (T-215's rule, one rung further).
    const { client } = seeded({ items: [], has_more: false }, { q: "M-" });
    const { findByText } = renderWithProviders(
      <SearchResults slug="todou" search={{ q: "M-" }} />,
      client,
    );
    const link = (await findByText("M-")).closest("a");
    expect(link?.getAttribute("href")).toBe("/projects/mirror");
    expect(link?.textContent).toContain("Mirror");
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
  const Boxes = () => (
    <>
      <SearchBox slug="todou" onEscape={onEscape} />
      {boxes > 1 && <SearchBox slug="todou" listAlign="start" />}
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
    // The box now navigates to a project home as well (T-263).
    component: Boxes,
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
    // Offered, not chosen: nothing is preselected (T-262), and Enter reaches
    // the card by resolving the reference rather than by following a
    // highlight the reader never asked for.
    expect(card?.getAttribute("aria-selected")).toBe("false");
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

    // Twice: the first press lands on the card, since nothing was selected.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    submit(utils.container);
    await waitFor(() =>
      expect(utils.where()).toEqual({
        pathname: "/projects/todou/search",
        search: { q: "T-141" },
      }),
    );
  });

  it("takes nothing back off the list once ArrowUp leaves the first row", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client);
    const input = await typeInto(utils, "T-141");
    await waitFor(() => expect(optionsOf(utils.container)).toHaveLength(2));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(input.getAttribute("aria-activedescendant")).not.toBeNull(),
    );
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // Back to where the box started: no highlight, and no `activedescendant`
    // for a screen reader to announce.
    await waitFor(() =>
      expect(input.getAttribute("aria-activedescendant")).toBeNull(),
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
    expect(placeholder?.getAttribute("aria-selected")).toBe("false");

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
    expect(card?.getAttribute("aria-selected")).toBe("false");
    expect(external?.getAttribute("href")).toBe(
      "https://github.com/o/r/issues/76",
    );
  });

  it("offers the external link alone when there is no card behind #76", async () => {
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
    expect(external?.getAttribute("aria-selected")).toBe("false");
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

  it("gives two boxes on one page listboxes of their own", async () => {
    const client = seedBox();
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client, { boxes: 2 });
    // The header mounts one box now, but the id is the box's own business:
    // a written one would put the same `aria-controls` on every instance.
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

  it("reads the domains out of `is:` before it looks at `?in=`", () => {
    expect(domainsOf({ q: "is:comment 部署" })).toEqual(["comments"]);
    expect(domainsOf({ q: "is:spec,comment" })).toEqual(["comments", "specs"]);
    expect(domainsOf({ q: "-is:spec" })).toEqual(["issues", "comments"]);
    // `is:` wins over an older link's `?in=`, and `?in=` still answers alone.
    expect(domainsOf({ q: "is:comment", in: "specs" })).toEqual(["comments"]);
    expect(domainsOf({ q: "部署", in: "specs" })).toEqual(["specs"]);
    expect(domainsOf({ q: "部署" })).toEqual([]);
  });

  it("writes the domains back into the query, and only when they narrow", () => {
    expect(withDomains("部署", ["comments"])).toBe("部署 is:comment");
    expect(withDomains("is:spec 部署", ["comments"])).toBe("部署 is:comment");
    // All three is what no `is:` already means; spelling it out is noise in
    // a URL somebody is going to paste.
    expect(withDomains("is:spec 部署", ["issues", "comments", "specs"])).toBe(
      "部署",
    );
    expect(withDomains("is:spec 部署", [])).toBe("部署");
    expect(withDomains("", ["specs"])).toBe("is:spec");
    // Everything else in the query survives untouched, quotes and all.
    expect(withDomains('is:spec label:"kind:bug" 慢', ["comments"])).toBe(
      'label:"kind:bug" 慢 is:comment',
    );
  });
});

/** A project whose labels, statuses, members and facets are already known. */
function seedPools(client: QueryClient): QueryClient {
  client.setQueryData(labelsQuery("todou").queryKey, [
    { id: 1, name: "area:web", color: "#111111" },
    { id: 2, name: "kind:bug", color: "#222222" },
  ]);
  client.setQueryData(statusesQuery("todou").queryKey, [status]);
  client.setQueryData(membersQuery("todou").queryKey, [
    {
      user: {
        id: 1,
        login: "alice",
        display_name: "Alice",
        kind: "human",
        avatar_url: null,
        owner: null,
      },
      role: "writer",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ]);
  client.setQueryData(searchFacetsQuery("todou", true).queryKey, {
    harnesses: [{ agent: "codex", count: 12 }],
    sessions: [
      {
        session_id: "sess-a",
        agent: "codex",
        count: 3,
        last_seen: "2026-09-01T00:00:00.000Z",
      },
    ],
  });
  return client;
}

const rowTexts = (container: HTMLElement) =>
  optionsOf(container).map((o) => o.textContent ?? "");

/** Mirror's open cards, for the peek under a project's home row (T-263). */
function seedPeek(client: QueryClient, count = 3): QueryClient {
  client.setQueryData(recentOpenIssuesQuery("mirror", PROJECT_PEEK).queryKey, {
    items: Array.from({ length: count }, (_, i) =>
      refItem(i + 1, `卡 ${i + 1}`),
    ),
    next_cursor: null,
  });
  return client;
}

/**
 * The results page mounted on its own route, so a chip's `navigate()` lands
 * somewhere the assertions can read.
 */
function renderPage(
  page: Omit<SearchPage, "diagnostics"> &
    Partial<Pick<SearchPage, "diagnostics">>,
  search: SearchPageSearch,
) {
  const client = seedJumpContext(testQueryClient());
  client.setQueryData(searchQuery("todou", search).queryKey, {
    diagnostics: [],
    ...page,
  });
  const rootRoute = createRootRoute();
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const searchRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "search",
    validateSearch: (raw: Record<string, unknown>) => raw as SearchPageSearch,
    component: () => (
      <SearchResults slug="todou" search={searchRoute.useSearch()} />
    ),
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const entry = `/projects/todou/search?${new URLSearchParams(
    Object.entries(search).map(([k, v]) => [k, String(v)]),
  )}`;
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      projectRoute.addChildren([searchRoute, issueRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    ...utils,
    client,
    where: () => ({
      pathname: router.state.location.pathname,
      search: router.state.location.search as SearchPageSearch,
    }),
  };
}

const chip = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

describe("the results page · qualifiers", () => {
  it("says what went wrong with the query, above the results", async () => {
    const utils = renderPage(
      {
        items: [],
        has_more: false,
        diagnostics: [
          {
            severity: "error",
            key: "label",
            value: "不存在",
            message: 'no label named "不存在" in this project',
            suggestion: "kind:bug",
          },
          {
            severity: "note",
            key: "harness",
            value: "claud",
            message: '"claud" is not a harness todou knows',
            suggestion: null,
          },
        ],
      },
      { q: "label:不存在 慢" },
    );
    await utils.findByText(/no label named/);
    await utils.findByText(/is not a harness/);
    // The suggestion is offered, not applied.
    await utils.findByText("kind:bug");
    // Still a results page, not an error page.
    await utils.findByText(/Nothing matched/);
  });

  it("writes a chip into the query rather than into `?in=`", async () => {
    const utils = renderPage({ items: [], has_more: false }, { q: "部署" });
    await utils.findByText(/Results for/);
    fireEvent.click(chip(utils.container, "Comments"));
    await waitFor(() =>
      expect(utils.where().search).toEqual({ q: "部署 is:comment" }),
    );
  });

  it("folds an older link's `?in=` into the query on the first click", async () => {
    const utils = renderPage(
      { items: [], has_more: false },
      { q: "部署", in: "comments" },
    );
    // Arriving on the old link, the chip it selected is the one shown.
    await waitFor(() =>
      expect(
        chip(utils.container, "Comments").getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(chip(utils.container, "Specs").getAttribute("aria-pressed")).toBe(
      "false",
    );

    fireEvent.click(chip(utils.container, "Specs"));
    await waitFor(() =>
      expect(utils.where().search).toEqual({ q: "部署 is:comment,spec" }),
    );
  });

  it("spells the syntax out where there is nothing to show yet", async () => {
    const utils = renderPage({ items: [], has_more: false }, { q: "" });
    await utils.findByText("harness:codex");
    await utils.findByText("which agent wrote the matched text");
  });

  it("offers no jump for a query that carries a qualifier", async () => {
    const utils = renderPage(
      { items: [], has_more: false },
      { q: "label:kind:bug T-141" },
    );
    utils.client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    await utils.findByText(/Nothing matched/);
    expect(utils.queryByText("全文搜索")).toBeNull();
  });
});

describe("SearchBox · qualifier completion", () => {
  it("keeps search first when what was typed completes nothing", async () => {
    // The whole ordering rule: the reader is writing a query, so an offer
    // has to earn its place above the thing they came to do.
    const utils = renderBox(seedPools(seedBox()));
    await typeInto(utils, "部署 ");
    await waitFor(() => expect(listboxOf(utils.container)).not.toBeNull());
    expect(rowTexts(utils.container)[0]).toContain("Search for");
    // The full table is still there, below, because that is how the syntax
    // gets discovered.
    expect(rowTexts(utils.container).join("\n")).toContain("harness:");
  });

  it("lifts a key above search once it is really a prefix", async () => {
    const utils = renderBox(seedPools(seedBox()));
    await typeInto(utils, "har");
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("harness:"),
    );
    expect(rowTexts(utils.container)[1]).toContain("Search for");
  });

  it("offers a project's own values once the colon is typed", async () => {
    const utils = renderBox(seedPools(seedBox()));
    const input = await typeInto(utils, "label:");
    input.setSelectionRange(6, 6);
    fireEvent.select(input);
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("area:web"),
    );
    expect(rowTexts(utils.container)[1]).toContain("kind:bug");
    expect(rowTexts(utils.container)[2]).toContain("Search for");
  });

  it("gives each offer one line and no more", async () => {
    const utils = renderBox(seedPools(seedBox()));
    await typeInto(utils, "har");
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("harness:"),
    );
    const row = optionsOf(utils.container)[0] as HTMLElement;
    expect(row.querySelectorAll("div, p, br")).toHaveLength(0);
  });

  it("takes an offer on Tab, and never the search row", async () => {
    const utils = renderBox(seedPools(seedBox()));
    const input = await typeInto(utils, "部署 har");
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("harness:"),
    );
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(input.value).toBe("部署 harness:"));
    expect(utils.where().pathname).toBe("/");
  });

  it("rewrites the query when an offer is clicked", async () => {
    const utils = renderBox(seedPools(seedBox()));
    const input = await typeInto(utils, "label:kind");
    input.setSelectionRange(10, 10);
    fireEvent.select(input);
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("kind:bug"),
    );
    fireEvent.click(optionsOf(utils.container)[0] as Element);
    // With the space that ends the word, so the next term can just be typed.
    await waitFor(() => expect(input.value).toBe("label:kind:bug "));
  });

  it("gives every row the full width of the panel", async () => {
    // A `<button>` row resolves `width: auto` to fit-content and shrank to a
    // pill beside its full-width neighbours (T-268). happy-dom has no layout
    // engine, so this only holds the two kinds of row to one width rule; the
    // width itself is measured in a browser.
    const utils = renderBox(seedPools(seedBox()));
    const input = await typeInto(utils, "label:kind");
    input.setSelectionRange(10, 10);
    fireEvent.select(input);
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("kind:bug"),
    );
    const [completion, search] = optionsOf(utils.container);
    expect(completion?.tagName).toBe("BUTTON");
    expect(completion?.className).toContain("w-full");
    expect(search?.className).toContain("w-full");
  });

  it("keeps the browser's own drop-down out of the way", async () => {
    // Two drop-downs cover each other, and the browser's knows neither the
    // syntax nor this project's labels (T-268).
    const utils = renderBox(seedPools(seedBox()));
    const input = await utils.findByLabelText("Search this project");
    expect(input.getAttribute("autocomplete")).toBe("off");
  });

  it("offers ten rows at most, however many values there are", async () => {
    // Forty labels opened a panel taller than the window, which then gave
    // the page its own scrollbar (T-268).
    const client = seedPools(seedBox());
    client.setQueryData(
      labelsQuery("todou").queryKey,
      Array.from({ length: 40 }, (_, i) => ({
        id: i + 1,
        name: `area:${i}`,
        color: "#111111",
      })),
    );
    const utils = renderBox(client);
    const input = await typeInto(utils, "label:");
    input.setSelectionRange(6, 6);
    fireEvent.select(input);
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("area:0"),
    );
    // Ten offers plus the search row, which is never spent.
    expect(optionsOf(utils.container)).toHaveLength(11);
    expect(rowTexts(utils.container).at(-1)).toContain("Search for");
  });

  it("stops offering a jump once the query carries a qualifier", async () => {
    // `label:kind:bug T-141` cannot honestly offer a card: following it
    // would drop the label the reader just typed.
    const client = seedPools(seedBox());
    client.setQueryData(
      issueRefQuery("todou", 141).queryKey,
      refItem(141, "全文搜索"),
    );
    const utils = renderBox(client);
    const input = await typeInto(utils, "T-141");
    await waitFor(() =>
      expect(rowTexts(utils.container).join("\n")).toContain("全文搜索"),
    );

    fireEvent.change(input, { target: { value: "label:kind:bug T-141" } });
    await waitFor(() =>
      expect(rowTexts(utils.container).join("\n")).not.toContain("全文搜索"),
    );
  });

  it("submits the query as typed when nothing is highlighted", async () => {
    const utils = renderBox(seedPools(seedBox()));
    await typeInto(utils, "harness:codex is:comment 部署");
    submit(utils.container);
    await waitFor(() =>
      expect(utils.where()).toEqual({
        pathname: "/projects/todou/search",
        search: { q: "harness:codex is:comment 部署" },
      }),
    );
  });

  it("completes a project's prefix from a word typed without the shift key", async () => {
    const utils = renderBox(seedPools(seedBox()));
    await typeInto(utils, "mi");
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("mirror/"),
    );
    // Above the search row, and still not chosen for the reader.
    expect(rowTexts(utils.container)[1]).toContain("Search for");
    const input = await utils.findByLabelText("Search this project");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("takes the completion on Tab and leaves the caret ready for a number", async () => {
    const client = seedPeek(seedPools(seedBox()));
    const utils = renderBox(client);
    const input = await typeInto(utils, "m");
    await waitFor(() => expect(rowTexts(utils.container)[0]).toContain("M-"));

    fireEvent.keyDown(input, { key: "Tab" });
    // No trailing space: `m` Tab `1` has to reach M-1 in three keystrokes.
    await waitFor(() => expect(input.value).toBe("M-"));
    expect(input.selectionStart).toBe(2);
  });

  it("offers the project's home first once its name is complete", async () => {
    const client = seedPeek(seedPools(seedBox()));
    const utils = renderBox(client);
    await typeInto(utils, "M-");
    await waitFor(() =>
      expect(rowTexts(utils.container)[0]).toContain("Mirror"),
    );
    const [home] = optionsOf(utils.container);
    expect(home?.getAttribute("href")).toBe("/projects/mirror");
    expect(home?.textContent).toContain("M-");
    // Enter with nothing arrowed onto follows it: searching the literal
    // `M-` would only find text that happens to spell it.
    submit(utils.container);
    await waitFor(() =>
      expect(utils.where().pathname).toBe("/projects/mirror"),
    );
  });

  it("lists what the named project is working on, under its home row", async () => {
    const client = seedPeek(seedPools(seedBox()), PROJECT_PEEK);
    const utils = renderBox(client);
    await typeInto(utils, "mirror/");
    await waitFor(() =>
      expect(rowTexts(utils.container).join("\n")).toContain("卡 1"),
    );
    const texts = rowTexts(utils.container);
    expect(texts[0]).toContain("mirror/");
    expect(texts[1]).toContain("mirror/M-1");
    // Five cards at most, then the search row — the ten-row budget is
    // shared, not added to (T-268).
    expect(optionsOf(utils.container)).toHaveLength(2 + PROJECT_PEEK);
    expect(texts.at(-1)).toContain("Search for");
    const card = optionsOf(utils.container)[1] as Element;
    expect(card.getAttribute("href")).toBe("/projects/mirror/issues/1");
  });

  it("keeps the panel within ten rows when a project has more open cards", async () => {
    const client = seedPeek(seedPools(seedBox()), 40);
    const utils = renderBox(client);
    await typeInto(utils, "mirror/");
    await waitFor(() =>
      expect(rowTexts(utils.container).join("\n")).toContain("卡 1"),
    );
    expect(optionsOf(utils.container).length).toBeLessThanOrEqual(11);
  });

  it("searches, rather than jumping, when the query is more than a name", async () => {
    const utils = renderBox(seedPeek(seedPools(seedBox())));
    await typeInto(utils, "M- 部署");
    submit(utils.container);
    await waitFor(() =>
      expect(utils.where()).toEqual({
        pathname: "/projects/todou/search",
        search: { q: "M- 部署" },
      }),
    );
  });

  it("keeps completing projects behind a qualifier, but offers no jump", async () => {
    // `hasQualifier` shuts the jump off, because following it would drop
    // the filter. Completion is the other path and stays open.
    const utils = renderBox(seedPeek(seedPools(seedBox())));
    await typeInto(utils, "label:kind:bug mi");
    await waitFor(() =>
      expect(rowTexts(utils.container).join("\n")).toContain("mirror/"),
    );
    expect(
      optionsOf(utils.container).some(
        (o) => o.getAttribute("href") === "/projects/mirror",
      ),
    ).toBe(false);
  });

  it("points an empty box at the search page rather than at an empty search", async () => {
    const utils = renderBox(seedPools(seedBox()));
    const input = await utils.findByLabelText("Search this project");
    input.focus();
    fireEvent.focusIn(input);
    await waitFor(() => expect(listboxOf(utils.container)).not.toBeNull());
    const [first] = optionsOf(utils.container);
    expect(first?.textContent).toContain("search page");
    expect(first?.textContent).not.toContain("Search for");
    // A blank query, not `?q=` — the page's own empty state is the syntax
    // help, and that is what this row is for.
    expect(first?.getAttribute("href")).toBe("/projects/todou/search");
  });

  it("paints the query behind the input, character for character", async () => {
    const utils = renderBox(seedPools(seedBox()));
    await typeInto(utils, "label:不存在 慢");
    const mirror = utils.container.querySelector("[aria-hidden] span");
    await waitFor(() => expect(mirror?.textContent).toBe("label:不存在 慢"));
    // The label does not exist in this project, and the mirror says so.
    expect(mirror?.innerHTML).toContain("decoration-wavy");
  });
});
