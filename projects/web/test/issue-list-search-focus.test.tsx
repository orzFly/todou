import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  IssueCounts,
  IssueListItem,
  IssueListPage,
  Me,
  Member,
  Project,
  Status,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueSearchSchema } from "../src/api/issues.ts";
import { AppShell } from "../src/components/shell.tsx";
import {
  narrowByTitle,
  ProjectIssueListPage,
} from "../src/pages/issue-list.tsx";
import { testQueryClient } from "./render.tsx";

/**
 * The first ancestor painted out of existence, or null. Copied from
 * `shell-stays-during-navigation.test.tsx`, where it is file-private: React
 * does not unmount the children a Suspense boundary stands in for — it sets
 * `display: none !important` on them — so "the search box vanished" is a
 * style on something above it, not a missing node.
 */
function hiddenAncestorOf(element: Element | null): Element | null {
  let node: Element | null = element;
  while (node !== null) {
    if (node instanceof HTMLElement && node.style.display === "none") {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: true,
  created_at: "2026-01-01T00:00:00Z",
};

const project: Project = {
  id: 1,
  slug: "alpha",
  name: "Alpha",
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  viewer_role: "admin",
};

const members: Member[] = [
  {
    user: {
      id: me.id,
      login: me.login,
      display_name: me.display_name,
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    role: "admin",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const next: Status = {
  id: 5,
  name: "Next",
  category: "open",
  color: "#f59e0b",
  position: 4,
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
const done: Status = {
  id: 9,
  name: "Done",
  category: "closed",
  color: "#22c55e",
  position: 6,
  is_default: false,
};
const statuses = [todo, next, done];

function item(id: number, title: string, status: Status): IssueListItem {
  return {
    id,
    number: id,
    title,
    status,
    author: members[0].user,
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

/**
 * Four loaded rows, two of which carry "foc" in the title. The asymmetry the
 * two-stage filter exists for is in here: the server also matches bodies, and
 * a list row has no body to match.
 */
const LOADED: Record<string, IssueListItem[]> = {
  "5": [
    item(51, "focus falls out of the box", next),
    item(52, "watermark reserve", next),
  ],
  "2": [
    item(21, "the focus ring on the toolbar", todo),
    item(22, "cursor semantics", todo),
  ],
};

const BASE_COUNTS: IssueCounts = {
  open: 4,
  closed: 0,
  by_status: { "5": 2, "2": 2 },
};

type Server = {
  fetch: typeof fetch;
  /** Lets every held `?q=` request answer, and every later one through. */
  open: () => void;
  /** How many times each query actually went to the network. */
  calls: { counts: number; rows: number };
  /** Flip to make every further counts request fail. */
  failCounts: boolean;
};

/**
 * Serves the project offline, holding every `?q=` request until `open()`.
 * The gate is the search round-trip: with it shut, the screen shows whatever
 * the first stage and the previous answer can produce between them.
 *
 * The default `?q=` answer is a title match, which is the first stage's own
 * rule; a case about the two stages disagreeing passes its own `rows`.
 */
function gatedServer(
  answers: {
    rows?: (q: string, statusId: string | null) => IssueListItem[];
    counts?: (q: string) => IssueCounts;
    failCounts?: boolean;
    nextCursor?: string | null;
  } = {},
): Server {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const loadedFor = (statusId: string | null) =>
    LOADED[statusId ?? ""] ?? Object.values(LOADED).flat();

  const server: Server = {
    fetch: (async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input), "http://test");
      const q = url.searchParams.get("q");
      const isCounts = url.pathname.endsWith("/issues/counts");
      const isRows = url.pathname.endsWith("/issues");
      if (!isCounts && !isRows) return new Response("{}", { status: 404 });

      if (isCounts) server.calls.counts += 1;
      else server.calls.rows += 1;
      if (q !== null) await opened;

      if (isCounts) {
        if (server.failCounts) return new Response("{}", { status: 500 });
        return json(
          q === null ? BASE_COUNTS : (answers.counts?.(q) ?? BASE_COUNTS),
        );
      }
      const statusId = url.searchParams.get("status");
      const items =
        q === null
          ? loadedFor(statusId)
          : (answers.rows?.(q, statusId) ??
            loadedFor(statusId).filter((i) =>
              i.title.toLowerCase().includes(q.toLowerCase()),
            ));
      const page: IssueListPage = {
        items,
        next_cursor: answers.nextCursor ?? null,
      };
      return json(page);
    }) as typeof fetch,
    open: () => release(),
    calls: { counts: 0, rows: 0 },
    failCounts: answers.failCounts ?? false,
  };
  return server;
}

/**
 * The real route shape around the page: the pathless `authed` layer carrying
 * the shell (and its Suspense boundary, the one that painted the page out),
 * `/projects/$slug`, and the index route whose `validateSearch` is what makes
 * the page's own `setSearch` reach the URL.
 */
function mountList(server: Server, initialEntry = "/projects/alpha") {
  vi.stubGlobal("fetch", server.fetch);
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode: "single" });
  client.setQueryData(["me"], me);
  client.setQueryData(["project", "alpha"], project);
  client.setQueryData(["statuses", "alpha"], statuses);
  client.setQueryData(["labels", "alpha"], []);
  client.setQueryData(["members", "alpha"], members);

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: () => (
      <AppShell me={me}>
        <Outlet />
      </AppShell>
    ),
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: () => <Outlet />,
  });
  // Re-renders the page from outside, which is how the page gets a fresh
  // `setSearch` identity without anything about the search changing.
  let rerender: () => void = () => {};
  const listRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    validateSearch: (search: Record<string, unknown>) =>
      issueSearchSchema.parse(search),
    staticData: { pageSkeleton: "list" as const },
    component: function ListShim() {
      const search = listRoute.useSearch();
      const [, setTick] = useState(0);
      rerender = () => setTick((n) => n + 1);
      return <ProjectIssueListPage slug="alpha" search={search} />;
    },
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>a card</div>,
  });
  const testRouter = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([listRoute, issueRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return { ...view, router: testRouter, client, rerender: () => rerender() };
}

/** What the URL currently carries as the search word. */
function urlQ(router: { state: { location: { search: unknown } } }): unknown {
  return (router.state.location.search as { q?: unknown }).q;
}

/** The search box, focused the way a user reaches it. */
function searchBox(): HTMLInputElement {
  const input = screen.getByPlaceholderText("Search issues…");
  input.focus();
  return input as HTMLInputElement;
}

/** Titles of the rows on screen, in order. */
function rowTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll("ul a[href*='/issues/']")].map(
    (a) => a.textContent ?? "",
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("typing in the issue list search box (T-381)", () => {
  it("never hides the search box while the search is in flight", async () => {
    const server = gatedServer();
    const view = mountList(server);
    await screen.findByText("focus falls out of the box");

    vi.useFakeTimers();
    const input = searchBox();
    await type(input, "foc");
    // Past the debounce, so the request is out and the gate is holding it.
    await advance(400);

    // These two are what the user actually loses, and they cannot fail here:
    // happy-dom leaves `activeElement` and the caret alone when an ancestor
    // turns into `display: none`, which was measured against the broken code
    // (it reported `activeElement=INPUT selectionStart=3` while the page was
    // hidden). They record the intent; the two assertions below them are what
    // separates the fixed code from the broken code, because the hidden
    // ancestor is the mechanism a real browser takes the focus away over. A
    // browser-level check is on the card.
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe("foc".length);

    expect(hiddenAncestorOf(input)).toBeNull();
    expect(screen.queryByTestId("page-skeleton")).toBeNull();
    expect(view.container.querySelector("header")).not.toBeNull();
  });

  it("holds the previous rows rather than skeletons while the search is out", async () => {
    const server = gatedServer();
    const view = mountList(server);
    await screen.findByText("focus falls out of the box");

    vi.useFakeTimers();
    await type(searchBox(), "foc");
    await advance(400);

    expect(screen.queryByTestId("issue-list-body-skeleton")).toBeNull();
    expect(rowTitles(view.container).length).toBeGreaterThan(0);
  });
});

describe("narrowByTitle (T-381)", () => {
  it("only ever removes rows, and keeps only title matches", () => {
    const all = Object.values(LOADED).flat();
    for (const word of ["foc", "  FOC  ", "w", "zzz", ""]) {
      const kept = narrowByTitle(all, word);
      expect(all).toEqual(expect.arrayContaining(kept));
      expect(kept.length).toBeLessThanOrEqual(all.length);
      for (const row of kept) {
        expect(row.title.toLowerCase()).toContain(word.trim().toLowerCase());
      }
    }
  });
});

describe("the first stage of the search (T-381)", () => {
  it("narrows the rows before the debounce has sent anything", async () => {
    const server = gatedServer();
    const view = mountList(server);
    await screen.findByText("watermark reserve");
    const before = { ...server.calls };

    vi.useFakeTimers();
    // A word that sits in the middle of the one title carrying it, so an
    // implementation that narrows too hard fails here as loudly as one that
    // narrows too little.
    await type(searchBox(), "ring");
    await advance(100);

    expect(rowTitles(view.container)).toEqual([
      "the focus ring on the toolbar",
    ]);
    expect(server.calls).toEqual(before);
  });

  it("stops narrowing once the server has answered, body-only matches and all", async () => {
    // The asymmetry the two stages exist for: the server matches this card
    // on its body, and no title filter could ever keep it.
    const server = gatedServer({
      rows: (q, statusId) =>
        q === "search" && statusId === "5"
          ? [item(77, "the box loses its place", next)]
          : [],
    });
    const view = mountList(server);
    await screen.findByText("focus falls out of the box");

    vi.useFakeTimers();
    await type(searchBox(), "search");
    await advance(400);

    expect(rowTitles(view.container)).toEqual([]);
    expect(screen.queryByText("the box loses its place")).toBeNull();

    server.open();
    await advance(50);

    expect(rowTitles(view.container)).toEqual(["the box loses its place"]);
  });

  it("holds the group boxes and says the answer is still out", async () => {
    const server = gatedServer({
      rows: () => [],
      counts: () => ({ open: 0, closed: 0, by_status: {} }),
    });
    const view = mountList(server);
    await screen.findByText("focus falls out of the box");

    vi.useFakeTimers();
    await type(searchBox(), "zzz");
    await advance(400);

    expect(view.container.querySelectorAll("section[aria-label]")).toHaveLength(
      2,
    );
    expect(screen.getAllByText("Searching…")).toHaveLength(2);
    expect(screen.queryByText(/No issues match/)).toBeNull();
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
    expect(screen.queryByTestId("issue-list-body-skeleton")).toBeNull();

    server.open();
    await advance(50);

    // The server has spoken, and only now may the screen say there is nothing.
    expect(screen.queryAllByText("Searching…")).toEqual([]);
    expect(screen.getByText(/No issues match/)).toBeTruthy();
  });

  it("does the same in the flat view, pager and all", async () => {
    const server = gatedServer({ rows: () => [], nextCursor: "c1" });
    mountList(server, "/projects/alpha?group=none");
    await screen.findByText("focus falls out of the box");
    expect(screen.getByText("Load more")).toBeTruthy();

    vi.useFakeTimers();
    await type(searchBox(), "zzz");
    await advance(400);

    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText(/No issues match/)).toBeNull();
    expect(screen.queryByText("Load more")).toBeNull();

    server.open();
    await advance(50);

    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.getByText(/No issues match/)).toBeTruthy();
  });

  it("gives the pager back once the answer it pages is the one on screen", async () => {
    const server = gatedServer({ nextCursor: "c1" });
    mountList(server, "/projects/alpha?group=none");
    await screen.findByText("focus falls out of the box");
    expect(screen.getByText("Load more")).toBeTruthy();

    vi.useFakeTimers();
    await type(searchBox(), "foc");
    await advance(400);

    // Still paging the previous word's query, so it may not be offered.
    expect(screen.queryByText("Load more")).toBeNull();

    server.open();
    await advance(50);

    expect(screen.getByText("Load more")).toBeTruthy();
  });
});

describe("the search box and the URL (T-381)", () => {
  it("opens a ?q= link with the word in the box and the server's rows", async () => {
    const server = gatedServer();
    server.open();
    const view = mountList(server, "/projects/alpha?q=foc");

    const input = (await screen.findByPlaceholderText(
      "Search issues…",
    )) as HTMLInputElement;
    expect(input.value).toBe("foc");
    await waitFor(() =>
      expect(rowTitles(view.container)).toEqual([
        "focus falls out of the box",
        "the focus ring on the toolbar",
      ]),
    );
  });

  it("does not eat the character typed while its own write is landing", async () => {
    const server = gatedServer();
    server.open();
    const view = mountList(server);
    await screen.findByText("focus falls out of the box");

    vi.useFakeTimers();
    const input = searchBox();
    await type(input, "foc");
    // The debounce fires and the user keeps typing before the router has
    // committed the navigation — the race the `written` ref exists for.
    await act(async () => {
      vi.advanceTimersByTime(300);
      fireEvent.change(input, { target: { value: "focus" } });
    });

    expect(urlQ(view.router)).toBe("foc");
    expect(input.value).toBe("focus");
  });

  it("writes the URL even while the page re-renders under the debounce", async () => {
    const server = gatedServer();
    server.open();
    const view = mountList(server);
    await screen.findByText("focus falls out of the box");

    vi.useFakeTimers();
    await type(searchBox(), "w");
    // A re-render every 100ms, each handing the page a fresh writer: an SSE
    // invalidation, a settling mutation, an arriving query. None of them is
    // an edit to the search box, so none of them may restart the timer.
    for (let i = 0; i < 5; i += 1) {
      await advance(100);
      await act(async () => {
        view.rerender();
      });
    }

    expect(urlQ(view.router)).toBe("w");
  });
});

describe("a failed counts read (T-381)", () => {
  it("offers a retry in the list area instead of throwing the page away", async () => {
    const view = mountList(gatedServer({ failCounts: true }));

    await screen.findByText(/Could not load the counts/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    const header = view.container.querySelector("header");
    expect(header).not.toBeNull();
    expect(hiddenAncestorOf(header)).toBeNull();
    expect(screen.queryByTestId("page-skeleton")).toBeNull();
  });

  it("keeps the groups when the refetch fails over numbers that already arrived", async () => {
    const server = gatedServer();
    const view = mountList(server);
    await screen.findByText("focus falls out of the box");

    server.failCounts = true;
    await act(async () => {
      await view.client.invalidateQueries({
        queryKey: ["issues", "alpha", "counts"],
      });
    });

    await screen.findByText(/Could not load the counts/);
    expect(screen.getByText("focus falls out of the box")).toBeTruthy();
    expect(view.container.querySelectorAll("section[aria-label]")).toHaveLength(
      2,
    );
  });
});
