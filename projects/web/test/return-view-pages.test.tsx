import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  ActivityCalendarResponse,
  InboxItem,
  InboxPage as InboxPageData,
  IssueCounts,
  IssueListItem,
  IssueListPage,
  Label,
  Member,
  PublicUser,
  ReferenceDirectory,
  Status,
  UserIssueItem,
  UserIssuesPage,
} from "@todou/shared";
import {
  createElement,
  type ReactNode,
  Suspense,
  useSyncExternalStore,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardColumnQuery } from "../src/api/board.ts";
import {
  issueGroupQuery,
  issueSearchSchema,
  issuesQuery,
} from "../src/api/issues.ts";
import { api, meQuery, statusesQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { userQuery, userSearchSchema } from "../src/api/users.ts";
import type * as CalendarSectionModule from "../src/components/activity-calendar/activity-calendar-section.tsx";
import * as returnContext from "../src/components/shared/return-context.tsx";
import { ReturnViewProvider } from "../src/components/shared/return-context.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../src/components/ui/dialog.tsx";
import {
  RETURN_VIEW_VERSION,
  type ReturnView,
  type ScrollRegion,
} from "../src/lib/return-view.ts";
import {
  readCurrentReturnEntry,
  writeReturnEntry,
} from "../src/lib/return-view-history.ts";
import { BoardPage } from "../src/pages/board.tsx";
import { InboxPage } from "../src/pages/inbox.tsx";
import { ProjectIssueListPage } from "../src/pages/issue-list.tsx";
import { router as appRouter } from "../src/router.tsx";
import { testQueryClient } from "./render.tsx";

/**
 * The server states each cell's instants; fixtures spell out plain UTC ones so
 * a test's own dates stay readable. Only the DST cases below vary them.
 */
function dayBounds(date: string): { start: string; end: string } {
  // Cases that feed deliberately malformed dates still need a parseable pair:
  // the assertion under test is about `date`, not about these.
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed))
    return {
      start: "2024-01-01T00:00:00.000Z",
      end: "2024-01-02T00:00:00.000Z",
    };
  const next = new Date(parsed + 86_400_000).toISOString().slice(0, 10);
  return { start: `${date}T00:00:00.000Z`, end: `${next}T00:00:00.000Z` };
}

// Suspend only the user calendar in the lazy-layout case. Once released this
// renders the real endpoint wrapper and calendar; no readiness is simulated.
const userCalendarModule = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
}));
vi.mock(
  "../src/components/activity-calendar/activity-calendar-section.tsx",
  async (importOriginal) => {
    const actual = await importOriginal<typeof CalendarSectionModule>();
    return {
      ...actual,
      ActivityCalendarSection: (
        props: Parameters<typeof actual.ActivityCalendarSection>[0],
      ) => {
        if (userCalendarModule.wait) throw userCalendarModule.wait;
        return createElement(actual.ActivityCalendarSection, props);
      },
    };
  },
);

/**
 * The page half of T-407: which pages a returning collection asks for, in
 * which lane, in which order, and what happens when the reader interferes.
 *
 * Every case arrives the way a reader does — with the snapshot on the history
 * entry and nothing in the URL — and drives the real page components, because
 * the lanes and the scrolling regions are registered by the pages themselves
 * and a page that stopped registering one is exactly the regression worth
 * catching. happy-dom lays nothing out, so the assertions are about what was
 * ASKED FOR and what state resulted; the pixels belong in a browser.
 */

const VIEWER = 7;

const todo: Status = {
  id: 2,
  name: "Todo",
  category: "open",
  color: "#123456",
  position: 1,
  is_default: true,
};
const next: Status = {
  id: 5,
  name: "Next",
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

const author = {
  id: VIEWER,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const alice: PublicUser = { ...author, created_at: "2026-01-01T00:00:00Z" };

const MEMBERS: Member[] = [
  { user: author, role: "admin", created_at: "2026-01-01T00:00:00Z" },
];

function item(id: number, title: string, status: Status): IssueListItem {
  return {
    id,
    number: id,
    title,
    status,
    author,
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

const page = (
  items: IssueListItem[],
  cursor: string | null,
): IssueListPage => ({ items, next_cursor: cursor });

type Query = Record<string, unknown>;

/**
 * A stand-in for `api.listIssues` that records what was asked for, and can
 * hold or fail one cursor's answer at a time.
 *
 * `peakPagesInFlight` earns its keep: a lane is replayed one page at a time
 * because the cursor for page N+1 only exists once page N has landed, and a
 * driver that fired every owed page at once would produce the same rows in the
 * same order here — only the concurrency tells the two apart.
 *
 * It counts cursor-bearing calls alone. The FIRST page is a query like any
 * other: seeded into the cache it is stale on mount, so react-query refreshes
 * it in the background while the replay walks the chain, and a counter that
 * included that would report a concurrency the replay never had.
 */
function issueServer(answer: (query: Query) => IssueListPage) {
  const gates = new Map<string, { wait: Promise<void>; open: () => void }>();
  const state = {
    calls: [] as Query[],
    /** Replayed pages out right now, and the most there have ever been. */
    pagesInFlight: 0,
    peakPagesInFlight: 0,
    failing: new Set<string>(),
    /** Make the answer for this cursor wait until `release` is called. */
    hold(cursor: string) {
      let open: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        open = () => resolve();
      });
      gates.set(cursor, { wait, open });
    },
    release(cursor: string) {
      gates.get(cursor)?.open();
      gates.delete(cursor);
    },
  };
  vi.spyOn(api, "listIssues").mockImplementation((async (
    _slug: string,
    query: Query = {},
  ) => {
    const cursor = String(query.cursor ?? "first");
    state.calls.push(query);
    const replayed = query.cursor !== undefined;
    if (replayed) {
      state.pagesInFlight += 1;
      state.peakPagesInFlight = Math.max(
        state.peakPagesInFlight,
        state.pagesInFlight,
      );
    }
    const gate = gates.get(cursor);
    try {
      if (gate !== undefined) await gate.wait;
      else await new Promise((resolve) => setTimeout(resolve, 0));
      if (state.failing.has(cursor)) throw new Error("the server said no");
      return answer(query);
    } finally {
      if (replayed) state.pagesInFlight -= 1;
    }
  }) as typeof api.listIssues);
  return state;
}

/** The cursors asked for, in the order they were asked for. */
const cursorsOf = (server: { calls: Query[] }): unknown[] =>
  server.calls.filter((c) => c.cursor !== undefined).map((c) => c.cursor);

/** The cursors asked for on behalf of one status group. */
const groupCursorsOf = (
  server: { calls: Query[] },
  statusId: number,
): unknown[] =>
  server.calls
    .filter((c) => Array.isArray(c.status) && c.status[0] === statusId)
    .filter((c) => c.cursor !== undefined)
    .map((c) => c.cursor);

/**
 * A frozen capture of a collection, as the detail page's back link carries it.
 * It goes in through the real parser, so a case that spells a target the schema
 * would reject gets no restore at all rather than a silent pass.
 */
function snapshot(over: Partial<ReturnView> = {}): ReturnView {
  return {
    v: RETURN_VIEW_VERSION,
    userId: VIEWER,
    snapshotId: "snap-1",
    target: { kind: "list", slug: "alpha", search: { group: "none" } },
    pages: [],
    scroll: [],
    ...over,
  };
}

/** One remembered region, defaulted so a case names only what it is about. */
const region = (
  over: Partial<ScrollRegion> & { region: string },
): ScrollRegion => ({ x: 0, y: 400, candidates: [], ...over });

/**
 * A real flush: macrotasks, so React commits, react-query settles and the
 * restore's own `requestAnimationFrame` gets to run.
 */
async function settle(ms = 80) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * Settle until `done` holds, or until the budget is spent.
 *
 * A flat number is the wrong instrument for a case that waits on a CHAIN of
 * round trips. Mounting one of these pages under happy-dom — the router
 * resolving the route, the Suspense boundary handing over, the filter bar and
 * its menus rendering — costs about 200ms before the replay's first request
 * can leave at all, and every replayed page another 50ms or so; on a loaded
 * machine both figures double. Budgets picked for a page that mounts instantly
 * were timing the machine rather than the feature.
 *
 * Waiting for a condition weakens nothing: the expectations after the wait are
 * unchanged, so a replay that walks the wrong cursors still fails on them, and
 * one that never happens spends the whole budget and fails anyway.
 */
async function settleUntil(done: () => boolean, budget = 2000) {
  const deadline = Date.now() + budget;
  while (!done() && Date.now() < deadline) await settle(25);
}

/** Whether this page's restore has retired: it is owed nothing further. */
const settled = (router: Parameters<typeof readCurrentReturnEntry>[0]) => () =>
  entryOf(router).pending === undefined;

/** The history entry a back link hands the collection page. */
function historyAt(
  path: string,
  entry?: { pending?: ReturnView; locate?: boolean; state?: unknown },
) {
  const history = createMemoryHistory({ initialEntries: [path] });
  if (entry?.state !== undefined) {
    history.replace(history.location.href, entry.state as never);
    history.flush();
  } else if (entry?.pending !== undefined) {
    // The router is not built yet, and a write needs only these two of it.
    writeReturnEntry(
      { history, _scroll: { next: true } },
      { pending: { view: entry.pending, locate: entry.locate ?? true } },
    );
  }
  return history;
}

/**
 * Who the shell believes is reading, and when it learns.
 *
 * `/api/me` is a query like any other, so on a cold load the shell renders the
 * page before it has an account — and a snapshot belongs to a reader, so
 * nothing may be read from or written to the history entry until one is known.
 * A test that wants that window drives it through `arrive()`.
 */
function account(initial?: number) {
  let viewerId = initial;
  const listeners = new Set<() => void>();
  return {
    arrive(id: number = VIEWER) {
      viewerId = id;
      for (const listener of listeners) listener();
    },
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    get: () => viewerId,
  };
}

type Account = ReturnType<typeof account>;

/** The provider the shell puts around the whole authenticated app. */
const returnRoot = (who: Account, extra?: ReactNode) =>
  createRootRoute({
    component: function Shell() {
      const viewerId = useSyncExternalStore(who.subscribe, who.get, who.get);
      return (
        <ReturnViewProvider viewerId={viewerId}>
          <Outlet />
          {extra}
        </ReturnViewProvider>
      );
    },
  });

/** The row anchors on screen, in document order. */
function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-return-id]")].map(
    (row) => row.dataset.returnId ?? "",
  );
}

/**
 * The window scrolls this feature performed, and not the router's.
 * `@tanstack/router-core` resets the viewport on its own navigations with
 * `{top, left, behavior}`; `applyArea` moves one axis and names only that one,
 * so the argument's shape is what tells a restore's scroll from a reset.
 */
const restoreScrolls = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
  spy.mock.calls
    .map(([argument]) => argument)
    .filter(
      (argument) =>
        typeof argument === "object" &&
        argument !== null &&
        !("behavior" in argument),
    );

/** What the reader's own click would freeze, and what a reload would find. */
const entryOf = (router: Parameters<typeof readCurrentReturnEntry>[0]) =>
  readCurrentReturnEntry(router, VIEWER);

// ————— the project list —————

const COUNTS: IssueCounts = {
  open: 12,
  closed: 0,
  by_status: { "2": 4, "5": 8 },
};

/** Everything the list page reads that this file is not about. */
function listClient(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(["me"], { ...author, email: null });
  client.setQueryData(["project", "alpha"], {
    id: 1,
    slug: "alpha",
    name: "Alpha",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    viewer_role: "admin",
  });
  client.setQueryData(statusesQuery("alpha").queryKey, [todo, next, done]);
  client.setQueryData(["labels", "alpha"], [] as Label[]);
  client.setQueryData(["members", "alpha"], MEMBERS);
  vi.spyOn(api, "getIssueCounts").mockResolvedValue(COUNTS);
  return client;
}

function mountList({
  path = "/projects/alpha?group=none",
  pending,
  locate,
  state,
  client = listClient(),
  who = account(VIEWER),
  extra,
}: {
  path?: string;
  pending?: ReturnView;
  locate?: boolean;
  state?: unknown;
  client?: QueryClient;
  who?: Account;
  /** Rendered beside the page, inside the same shell and the same React root. */
  extra?: ReactNode;
} = {}) {
  const rootRoute = returnRoot(who, extra);
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: () => <Outlet />,
  });
  const listRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    validateSearch: (search: Record<string, unknown>) =>
      issueSearchSchema.parse(search),
    component: function ListShim() {
      const search = listRoute.useSearch();
      return (
        <Suspense fallback={<div>loading list</div>}>
          <ProjectIssueListPage slug="alpha" search={search} />
        </Suspense>
      );
    },
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>a card</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      projectRoute.addChildren([listRoute, issueRoute]),
    ]),
    history: historyAt(path, { pending, locate, state }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client, who };
}

/** Five pages of a flat list, each linked to the next by a live cursor. */
const FLAT_CHAIN: Record<string, IssueListPage> = {
  first: page([item(101, "one", todo), item(102, "two", todo)], "c1"),
  c1: page([item(103, "three", todo), item(104, "four", todo)], "c2"),
  c2: page([item(105, "five", todo), item(106, "six", todo)], "c3"),
  c3: page([item(107, "seven", todo), item(108, "eight", todo)], "c4"),
  c4: page([item(109, "nine", todo), item(110, "ten", todo)], null),
};

const FLAT_SEARCH = { group: "none" } as const;

function flatServer(extra: Record<string, IssueListPage> = {}) {
  const chain = { ...FLAT_CHAIN, ...extra };
  return issueServer((query) => {
    if (query.cursor === undefined && query.q === "pot") {
      return chain.potato ?? page([], null);
    }
    if (query.cursor === undefined && query.category === "closed") {
      return chain.closed ?? page([], null);
    }
    return chain[String(query.cursor ?? "first")];
  });
}

/** The flat list, seeded with page one and a snapshot that read `depth` more. */
function mountFlat(depth: number, over: Parameters<typeof mountList>[0] = {}) {
  const client = listClient();
  client.setQueryData(
    issuesQuery("alpha", FLAT_SEARCH).queryKey,
    FLAT_CHAIN.first,
  );
  return mountList({
    client,
    pending: snapshot({ pages: [{ lane: "flat", extraPages: depth }] }),
    ...over,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nothing is read or written before the account lands", () => {
  it("still owes its pages when the page mounted ahead of /api/me", async () => {
    const server = flatServer();
    const who = account();
    const view = mountFlat(3, { who });
    // The window the shell really has on a cold load: the list is mounted and
    // rendering, and nobody knows who is reading it yet.
    await settle(150);
    expect(cursorsOf(server)).toEqual([]);

    who.arrive();
    await settleUntil(settled(view.router));

    // The target has to have survived that window. A snapshot written while
    // the reader was unknown takes the pending restore out of the entry on
    // its way past, and the account arriving then finds nothing left to do —
    // silently, with the list sitting on page one.
    expect(cursorsOf(server)).toEqual(["c1", "c2", "c3"]);
    expect(rowIds(view.container)).toHaveLength(8);
  });

  it("leaves the entry exactly as it found it while the reader is unknown", async () => {
    const who = account();
    const view = mountFlat(3, { who });
    await settle(150);
    const held = (
      view.router.history.location.state as {
        todouReturn?: { view?: unknown; pending?: { view: ReturnView } };
      }
    ).todouReturn;
    // The restore target is still there, and nothing has been written beside
    // it. A view stamped with a placeholder id would be discarded on the way
    // back in — but it would already have taken the target with it, and
    // `pages`/`scroll` read off a half-built page would be what the reader
    // came back to.
    expect(held?.pending?.view.pages).toEqual([
      { lane: "flat", extraPages: 3 },
    ]);
    expect(held?.view).toBeUndefined();
  });
});

describe("a flat list comes back as deep as it was read", () => {
  it("replays three pages along the live cursor chain, one at a time", async () => {
    const server = flatServer();
    const view = mountFlat(3);
    await settleUntil(settled(view.router));

    // The cursors, not the count: a replay that reused cursors the snapshot
    // was written with — rather than following the chain the CURRENT first
    // page answers with — would load pages nobody is looking at.
    expect(cursorsOf(server)).toEqual(["c1", "c2", "c3"]);
    expect(server.peakPagesInFlight).toBe(1);
    // Every row once, in order: merging replayed pages by anything other than
    // issue id doubles up whatever the first page already held.
    expect(rowIds(view.container)).toEqual([
      "101",
      "102",
      "103",
      "104",
      "105",
      "106",
      "107",
      "108",
    ]);
  });

  it("hands the reader's own Load more the cursor the replay ended on", async () => {
    const server = flatServer();
    const view = mountFlat(3);
    // Past the replay, so the control is idle and the click is the reader's
    // first page rather than one the restore was already bringing.
    await settleUntil(settled(view.router));

    fireEvent.click(view.getByRole("button", { name: "Load more" }));
    await settleUntil(() => rowIds(view.container).includes("109"));

    // `c4`, the fourth page's own next cursor — a click that re-appended a
    // page the replay already loaded would ask for `c3` and duplicate rows.
    expect(cursorsOf(server)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(rowIds(view.container).filter((id) => id === "109")).toEqual([
      "109",
    ]);
  });
});

// ————— the grouped list —————

const GROUP_SEARCH = {} as const;

/** Two groups, read to different depths, on cursor chains of their own. */
const GROUP_CHAIN: Record<string, IssueListPage> = {
  "5:first": page([item(501, "next one", next)], "n1"),
  "5:n1": page([item(502, "next two", next)], "n2"),
  "5:n2": page([item(503, "next three", next)], "n3"),
  "5:n3": page([item(504, "next four", next)], "n4"),
  "2:first": page([item(201, "todo one", todo)], "t1"),
  "2:t1": page([item(202, "todo two", todo)], "t2"),
  "2:t2": page([item(203, "todo three", todo)], "t3"),
};

const groupServer = () =>
  issueServer((query) => {
    const status = Array.isArray(query.status) ? query.status[0] : "?";
    return GROUP_CHAIN[`${status}:${String(query.cursor ?? "first")}`];
  });

function mountGrouped(statuses: Status[]) {
  const client = listClient();
  client.setQueryData(statusesQuery("alpha").queryKey, statuses);
  for (const status of statuses.filter((s) => s.category === "open")) {
    client.setQueryData(
      issueGroupQuery("alpha", status.id, GROUP_SEARCH).queryKey,
      GROUP_CHAIN[`${status.id}:first`],
    );
  }
  return mountList({
    client,
    path: "/projects/alpha",
    pending: snapshot({
      target: { kind: "list", slug: "alpha", search: {} },
      pages: [
        { lane: "status:5", extraPages: 3 },
        { lane: "status:2", extraPages: 1 },
      ],
    }),
  });
}

describe("a grouped list comes back one depth per group", () => {
  it("gives each group its own depth instead of one depth for both", async () => {
    const server = groupServer();
    const view = mountGrouped([todo, next, done]);
    await settleUntil(settled(view.router));

    // Different depths on purpose: with both groups three deep, a driver that
    // crossed the lanes — or kept one count for the whole page — would pass.
    expect(groupCursorsOf(server, 5)).toEqual(["n1", "n2", "n3"]);
    expect(groupCursorsOf(server, 2)).toEqual(["t1"]);
    expect(rowIds(view.container)).toEqual([
      "501",
      "502",
      "503",
      "504",
      "201",
      "202",
    ]);
  });

  it("finds the same lane after the status was renamed", async () => {
    const server = groupServer();
    // The snapshot still says `status:5`. A lane named after the status's word
    // — or its place in the order — would no longer match anything here.
    const view = mountGrouped([todo, { ...next, name: "Up next" }, done]);
    await settleUntil(settled(view.router));

    expect(groupCursorsOf(server, 5)).toEqual(["n1", "n2", "n3"]);
  });
});

// ————— a new search word —————

describe("a new search word starts from page one", () => {
  it("does not replay the old word's page count against the new query", async () => {
    const server = flatServer({
      potato: page([item(301, "potato", todo)], "p1"),
    });
    // Held so the reader types while pages are still owed: with the replay
    // already finished there would be no count left to inherit.
    server.hold("c2");
    const view = mountFlat(3);
    await settle(150);

    fireEvent.change(view.getByPlaceholderText("Search issues…"), {
      target: { value: "pot" },
    });
    // Past the 300ms debounce, so the new word reaches the URL and its own
    // first page lands with a cursor of its own to be tempted by.
    await settle(500);
    server.release("c2");
    await settle(120);

    const forNewWord = server.calls.filter((call) => call.q === "pot");
    expect(forNewWord.length).toBeGreaterThan(0);
    expect(forNewWord.map((call) => call.cursor)).toEqual([undefined]);
    // The old word's count does not survive as a target the new query is
    // paged up to.
    expect(entryOf(view.router).pending).toBeUndefined();
  });
});

// ————— results that arrive too late —————

describe("a page that lands too late", () => {
  it("is not appended after the reader changed the filter", async () => {
    const server = flatServer({
      closed: page([item(901, "closed one", done)], "z1"),
    });
    server.hold("c1");
    const view = mountFlat(3);
    await settle(80);

    await act(async () => {
      await view.router.navigate({
        to: "/projects/$slug",
        params: { slug: "alpha" },
        search: { group: "none", category: "closed" },
      });
    });
    await settle(80);
    server.release("c1");
    await settle(150);

    // The replayed page belongs to a filter the reader has left; appending it
    // would mix open rows into the closed list.
    expect(rowIds(view.container)).toEqual(["901"]);
    // And the count it was being loaded towards does not come along either.
    expect(
      server.calls.filter(
        (c) => c.category === "closed" && c.cursor !== undefined,
      ),
    ).toEqual([]);
  });

  it("is not appended after the reader left the page", async () => {
    const server = flatServer();
    server.hold("c1");
    const view = mountFlat(3);
    await settle(80);

    await act(async () => {
      await view.router.navigate({
        to: "/projects/$slug/issues/$number",
        params: { slug: "alpha", number: "101" },
      });
    });
    expect(view.getByText("a card")).toBeTruthy();
    server.release("c1");
    await settle(150);

    // Nothing of the list is on screen, and the restore it belonged to is not
    // still walking the chain from somewhere off-page.
    expect(rowIds(view.container)).toEqual([]);
    expect(cursorsOf(server)).toEqual(["c1"]);
  });
});

// ————— the three ways a restore is taken over —————

describe("the three ways a reader takes a restore over", () => {
  it("scrolling keeps the pages coming and stops the positioning", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const server = flatServer();
    const listeners = vi.spyOn(window, "addEventListener");
    server.hold("c1");
    server.hold("c2");
    const view = mountFlat(3, {
      pending: snapshot({
        pages: [{ lane: "flat", extraPages: 3 }],
        scroll: [region({ region: "window", y: 900 })],
      }),
    });
    await waitFor(() => {
      expect(listeners.mock.calls.some(([type]) => type === "wheel")).toBe(
        true,
      );
      expect(cursorsOf(server)).toEqual(["c1"]);
    });
    // T-456: the reader takes over while the response is held, independently
    // of how long rendering this page takes.
    act(() => {
      window.dispatchEvent(new Event("wheel"));
    });
    expect(entryOf(view.router).pending?.locate).toBe(false);
    await act(async () => server.release("c1"));
    await waitFor(() => {
      expect(cursorsOf(server)).toEqual(["c1", "c2"]);
      expect(rowIds(view.container)).toEqual(["101", "102", "103", "104"]);
    });
    expect(entryOf(view.router).pending?.locate).toBe(false);
    expect(server.pagesInFlight).toBe(1);
    expect(restoreScrolls(scrollTo)).toEqual([]);
    await act(async () => server.release("c2"));
    await waitFor(() => {
      expect(rowIds(view.container)).toEqual([
        "101",
        "102",
        "103",
        "104",
        "105",
        "106",
        "107",
        "108",
      ]);
      expect(entryOf(view.router).pending).toBeUndefined();
    });

    expect(cursorsOf(server)).toEqual(["c1", "c2", "c3"]);
    expect(server.peakPagesInFlight).toBe(1);
    expect(server.pagesInFlight).toBe(0);
    expect(restoreScrolls(scrollTo)).toEqual([]);
  });

  it.each(["none", "gesture", "committed gesture", "replacement"])(
    "a queued placement respects %s before its frame runs",
    async (timing) => {
      const scrollTo = vi
        .spyOn(window, "scrollTo")
        .mockImplementation(() => {});
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frames.set(++frameId, callback);
          return frameId;
        },
      );
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        frames.delete(id);
      });
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
        5_000,
      );
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
      const runFrame = () => {
        const queued = [...frames.values()];
        frames.clear();
        for (const callback of queued) callback(performance.now());
      };
      const listeners = vi.spyOn(window, "addEventListener");
      const server = flatServer();
      server.hold("c1");
      const view = mountFlat(1, {
        pending: snapshot({
          pages: [{ lane: "flat", extraPages: 1 }],
          scroll: [region({ region: "window", y: 900 })],
        }),
      });
      const restoreAnotherEntry = async () => {
        await act(async () => {
          writeReturnEntry(view.router, {
            pending: {
              view: snapshot({
                snapshotId: "next-restore",
                pages: [{ lane: "flat", extraPages: 1 }],
                scroll: [region({ region: "window", y: 1_200 })],
              }),
              locate: true,
            },
          });
          // POP the same route, so this is a new restore in the same hook,
          // without a filter click or an unmount cancelling the old frame.
          view.router.history.push(view.router.history.location.href);
          view.router.history.back();
          view.router.history.flush();
        });
      };
      await waitFor(() => {
        expect(listeners.mock.calls.some(([type]) => type === "wheel")).toBe(
          true,
        );
        expect(cursorsOf(server)).toEqual(["c1"]);
      });
      await act(async () => server.release("c1"));
      await waitFor(() => {
        expect(rowIds(view.container)).toEqual(["101", "102", "103", "104"]);
        expect(frames.size).toBeGreaterThan(0);
      });
      expect(entryOf(view.router).pending?.locate).toBe(true);
      expect(restoreScrolls(scrollTo)).toEqual([]);
      if (timing === "committed gesture") {
        act(() => window.dispatchEvent(new Event("wheel")));
        await waitFor(() =>
          expect(entryOf(view.router).pending).toBeUndefined(),
        );
      }
      if (timing === "replacement") await restoreAnotherEntry();
      // The gesture can also arrive in the same turn as the frame, before
      // React commits. Both timings must revoke its positioning authority.
      act(() => {
        if (timing === "gesture") window.dispatchEvent(new Event("wheel"));
        runFrame();
      });
      await waitFor(() => expect(entryOf(view.router).pending).toBeUndefined());
      expect(cursorsOf(server)).toEqual(["c1"]);
      expect(rowIds(view.container)).toEqual(["101", "102", "103", "104"]);
      expect(server.peakPagesInFlight).toBe(1);
      expect(restoreScrolls(scrollTo)).toEqual(
        timing === "none"
          ? [{ top: 900 }]
          : timing === "replacement"
            ? [{ top: 1_200 }]
            : [],
      );
      if (timing === "committed gesture") {
        await restoreAnotherEntry();
        await waitFor(() => expect(frames.size).toBeGreaterThan(0));
        act(runFrame);
        await waitFor(() =>
          expect(entryOf(view.router).pending).toBeUndefined(),
        );
        expect(restoreScrolls(scrollTo)).toEqual([{ top: 1_200 }]);
      }
    },
  );

  it("a filter change stops the replay outright", async () => {
    const server = flatServer({
      closed: page([item(901, "closed one", done)], "z1"),
    });
    // The filter changes mid-replay, which is the only state in which there is
    // anything left to stop.
    server.hold("c2");
    const view = mountFlat(3);
    await settle(150);

    await act(async () => {
      await view.router.navigate({
        to: "/projects/$slug",
        params: { slug: "alpha" },
        search: { group: "none", category: "closed" },
      });
    });
    server.release("c2");
    await settle(250);

    // The new filter's own first page arrives and nothing pages it up: the
    // snapshot described a list the reader is no longer looking at.
    expect(rowIds(view.container)).toEqual(["901"]);
    expect(
      server.calls.filter(
        (c) => c.category === "closed" && c.cursor !== undefined,
      ),
    ).toEqual([]);
    expect(entryOf(view.router).pending).toBeUndefined();
  });

  it("the reader's own Load more appends once and retires the restore", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const server = flatServer();
    // The second replayed page is still out, so the click lands while the
    // restore is mid-replay — the only moment at which the two can collide.
    server.hold("c2");
    const view = mountFlat(3, {
      pending: snapshot({
        pages: [{ lane: "flat", extraPages: 3 }],
        scroll: [region({ region: "window", y: 900 })],
      }),
    });
    // Named by the word it wears mid-replay, which is the premise rather than
    // a detail: the page in flight is the restore's, the lane is one lane, and
    // the button reports the lane rather than who asked. Waiting for "Loading…"
    // is waiting for the collision this case is about — and the control is
    // still live, which is what makes the click below a click a reader can
    // make.
    await settleUntil(
      () => view.queryByRole("button", { name: "Loading…" }) !== null,
    );
    expect(restoreScrolls(scrollTo)).toEqual([]);

    fireEvent.click(view.getByRole("button", { name: "Loading…" }));
    server.release("c2");
    await settleUntil(() => rowIds(view.container).includes("105"));
    // And a moment past it, so a restore that carried on to `c3` regardless
    // has had the time to say so.
    await settle(100);

    // Paging past what was remembered is the reader taking the view over: the
    // page in flight lands exactly once rather than twice, nothing carries on
    // to the third, and the remembered position is not put back on top of
    // where they have paged themselves to.
    expect(rowIds(view.container).filter((id) => id === "105")).toEqual([
      "105",
    ]);
    expect(cursorsOf(server)).toEqual(["c1", "c2"]);
    expect(entryOf(view.router).pending).toBeUndefined();
    expect(restoreScrolls(scrollTo)).toEqual([]);
  });
});

// ————— the one gesture that is not a take-over —————

/**
 * happy-dom dispatches a composed event with `target` still on the node it
 * came from. A browser retargets it to the shadow host, and that retargeting
 * is the entire reason `ui/dialog.tsx` has anything to decide, so a fixture
 * without it would exercise a path no reader can reach. The real browser is
 * held to it separately, by the wrap smoke's `wheel-target-not-retargeted`
 * and `touch-target-not-retargeted`.
 */
function retargeted<E extends Event>(event: E, host: Element): E {
  Object.defineProperty(event, "target", {
    configurable: true,
    get: () => host,
  });
  return event;
}

/** A diff-shaped scroller: inside an open shadow root, with `travel` to give. */
function shadowScroller(host: Element, travel: number): Element {
  const code = document.createElement("div");
  code.style.overflowX = "auto";
  code.style.overflowY = "hidden";
  Object.defineProperty(code, "scrollWidth", {
    value: 390 + travel,
    configurable: true,
  });
  Object.defineProperty(code, "clientWidth", {
    value: 390,
    configurable: true,
  });
  host.attachShadow({ mode: "open" }).append(code);
  return code;
}

/** Both gestures the lock watches, aimed sideways across the diff. */
const GESTURES = {
  wheel(code: Element, host: Element) {
    code.dispatchEvent(
      retargeted(
        new WheelEvent("wheel", {
          deltaX: 120,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
        host,
      ),
    );
  },
  drag(code: Element, host: Element) {
    const at = (x: number) =>
      new Touch({ identifier: 0, target: host, clientX: x, clientY: 200 });
    // A drag is a pair: the dialog measures the move against where the finger
    // started, as the lock does.
    for (const [type, x] of [
      ["touchstart", 300],
      ["touchmove", 180],
    ] as const)
      code.dispatchEvent(
        retargeted(
          new TouchEvent(type, {
            touches: [at(x)],
            changedTouches: [at(x)],
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
          host,
        ),
      );
  },
};

/**
 * Reading a diff in a modal dialog is not abandoning the way back (T-473).
 *
 * The lock this dialog installs puts `overflow: hidden` on the body, so the
 * page behind it cannot move whatever the reader does; `ui/dialog.tsx` hands a
 * gesture over a shadow-rooted scroller past the lock with `stopPropagation`
 * so the diff itself can travel (T-450 for the wheel, T-471 for the finger),
 * and that call is also what keeps the gesture away from the window listener
 * below. The cases above cannot see any of this: they dispatch
 * `new Event("wheel")` straight at the window, which never travels the React
 * path where the release happens, so moving this listener to the capture phase
 * would leave every one of them green.
 *
 * The pair here is what makes that falsifiable. A scroller with room to move
 * is released and the restore finishes; the same gesture over a scroller with
 * nowhere left to go is not released, reaches the window, and retires the
 * positioning exactly as a gesture on the page itself does.
 */
describe("a gesture inside a modal dialog is not the reader taking over", () => {
  const diffDialog = (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Edit history</DialogTitle>
        <div data-diff-host />
      </DialogContent>
    </Dialog>
  );

  const owedRestore = () => ({
    pending: snapshot({
      pages: [{ lane: "flat", extraPages: 1 }],
      scroll: [region({ region: "window", y: 900 })],
    }),
    extra: diffDialog,
  });

  async function openDiff(server: ReturnType<typeof flatServer>) {
    await settleUntil(
      () =>
        cursorsOf(server).length > 0 &&
        document.querySelector("[data-diff-host]") !== null,
    );
    const host = document.querySelector("[data-diff-host]");
    expect(host).not.toBeNull();
    expect(cursorsOf(server)).toEqual(["c1"]);
    return host as Element;
  }

  it.each(["wheel", "drag"] as const)(
    "a %s over a diff with room to move leaves the restore its position",
    async (gesture) => {
      const scrollTo = vi
        .spyOn(window, "scrollTo")
        .mockImplementation(() => {});
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
        5_000,
      );
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
      const server = flatServer();
      server.hold("c1");
      const view = mountFlat(1, owedRestore());
      const host = await openDiff(server);

      const code = shadowScroller(host, 1_024);
      act(() => GESTURES[gesture](code, host));
      expect(entryOf(view.router).pending?.locate).toBe(true);

      await act(async () => server.release("c1"));
      await settleUntil(settled(view.router));
      expect(rowIds(view.container)).toEqual(["101", "102", "103", "104"]);
      expect(entryOf(view.router).pending).toBeUndefined();
      expect(restoreScrolls(scrollTo)).toEqual([{ top: 900 }]);
    },
  );

  it.each(["wheel", "drag"] as const)(
    "a %s the dialog does not release still takes the restore over",
    async (gesture) => {
      const scrollTo = vi
        .spyOn(window, "scrollTo")
        .mockImplementation(() => {});
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
        5_000,
      );
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
      const server = flatServer();
      server.hold("c1");
      const view = mountFlat(1, owedRestore());
      const host = await openDiff(server);

      // Nothing to scroll sideways: the lock keeps this one, and so the
      // window hears it.
      const code = shadowScroller(host, 0);
      act(() => GESTURES[gesture](code, host));
      expect(entryOf(view.router).pending?.locate).toBe(false);

      await act(async () => server.release("c1"));
      await settleUntil(settled(view.router));
      expect(rowIds(view.container)).toEqual(["101", "102", "103", "104"]);
      expect(entryOf(view.router).pending).toBeUndefined();
      expect(restoreScrolls(scrollTo)).toEqual([]);
    },
  );
});

// ————— a failure in the middle of the replay —————

describe("a page that fails during the replay", () => {
  it("shows the retryable failure and still owes the pages", async () => {
    const server = flatServer();
    // The list's second page, which is the replay's first: failing it is the
    // case the card names, and it needs no page to have landed first.
    server.failing.add("c1");
    const view = mountFlat(3);
    await settleUntil(
      () => view.queryByRole("button", { name: "Retry" }) !== null,
    );

    expect(view.getByText(/Could not load more/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
    // The reader asked for nothing and did nothing: what they had read to is
    // still owed, so a retry — or a reload — can still deliver it.
    expect(entryOf(view.router).pending?.view.pages).toEqual([
      { lane: "flat", extraPages: 3 },
    ]);
  });

  it("finishes the range once a retry succeeds", async () => {
    const server = flatServer();
    server.failing.add("c1");
    const view = mountFlat(3);
    await settleUntil(
      () => view.queryByRole("button", { name: "Retry" }) !== null,
    );
    expect(view.getByText(/Could not load more/)).toBeTruthy();

    server.failing.delete("c1");
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await settleUntil(settled(view.router));

    // A retry is the reader asking for the page the restore was already
    // loading, not for a page past it: the range finishes.
    expect(cursorsOf(server)).toEqual(["c1", "c1", "c2", "c3"]);
    expect(rowIds(view.container)).toEqual([
      "101",
      "102",
      "103",
      "104",
      "105",
      "106",
      "107",
      "108",
    ]);
  });
});

// ————— a reload in the middle of the restore —————

describe("a reload in the middle of a restore", () => {
  /** What a reload keeps of an entry: its serialised state, nothing else. */
  const reloadState = (router: { history: { location: { state: unknown } } }) =>
    JSON.parse(JSON.stringify(router.history.location.state)) as unknown;

  /** The same address again, with only that state to go on. */
  const reopen = (state: unknown) => mountFlat(0, { state });

  it("still owes three pages when only one has landed", async () => {
    const first = flatServer();
    first.hold("c2");
    const view = mountFlat(3);
    await settle(150);
    const state = reloadState(view.router);
    view.unmount();
    first.release("c2");
    vi.restoreAllMocks();

    // A reload keeps the entry and nothing else — fresh cache, fresh page —
    // and only this record still knows the reader had read three pages in.
    const server = flatServer();
    const revived = reopen(state);
    await settleUntil(settled(revived.router));

    expect(cursorsOf(server)).toEqual(["c1", "c2", "c3"]);
    expect(rowIds(revived.container)).toHaveLength(8);
  });

  it("brings the pages back but not a position the reader scrolled away from", async () => {
    const first = flatServer();
    first.hold("c2");
    const view = mountFlat(3, {
      pending: snapshot({
        pages: [{ lane: "flat", extraPages: 3 }],
        scroll: [region({ region: "window", y: 900 })],
      }),
    });
    // Not before the page is on screen: the gesture is heard by a listener
    // the restore installs, and a wheel dispatched while the router is still
    // resolving the route is a wheel over a blank page, which no reader can
    // perform. Waiting for the first replayed page puts it where the case
    // means it — mid-replay, with `c2` still held.
    await settleUntil(() => rowIds(view.container).includes("103"));
    act(() => {
      window.dispatchEvent(new Event("wheel"));
    });
    await settle(60);
    // The premise, read back through the same door a reload reads it through:
    // the pages are still owed and the positioning has been given up.
    expect(entryOf(view.router).pending?.locate).toBe(false);
    const state = reloadState(view.router);
    view.unmount();
    first.release("c2");
    vi.restoreAllMocks();

    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const server = flatServer();
    const revived = reopen(state);
    await settleUntil(() => rowIds(revived.container).length >= 8);

    expect(cursorsOf(server)).toEqual(["c1", "c2", "c3"]);
    expect(restoreScrolls(scrollTo)).toEqual([]);
  });
});

// ————— the user page —————

const userItem = (id: number, title: string): UserIssueItem => ({
  ...item(id, title, todo),
  project: { id: 1, slug: "alpha", name: "Alpha" },
});

const USER_PAGES: Record<string, UserIssuesPage> = {
  first: { items: [userItem(11, "u one")], next_cursor: "u1", has_more: true },
  u1: { items: [userItem(12, "u two")], next_cursor: "u2", has_more: true },
  u2: { items: [userItem(13, "u three")], next_cursor: null, has_more: false },
};

function userCalendar(
  input: Parameters<typeof api.getUserActivityCalendar>[1],
  recorded = false,
): ActivityCalendarResponse {
  const from = String(input.from);
  const date = `${from.slice(0, 4)}-03-04`;
  return {
    from,
    to: String(input.to),
    timezone: input.tz,
    cutoff: "2026-09-19T12:00:00Z",
    read_started_at: "2026-09-19T12:00:00Z",
    read_finished_at: "2026-09-19T12:00:00Z",
    days: recorded
      ? [{ date, ...dayBounds(date), state: "recorded", count: 1 }]
      : [],
    selection:
      recorded && input.day
        ? {
            date: input.day,
            total: 1,
            items: [
              {
                project: {
                  id: 1,
                  slug: "alpha",
                  name: "Alpha",
                  issue_prefix: "A",
                },
                issue_id: 21,
                number: 21,
                title: "calendar card",
                status: todo,
                url: "/projects/alpha/issues/21",
                last_active_at: `${date}T12:00:00Z`,
              },
            ],
            next_cursor: null,
            has_more: false,
          }
        : null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function mountUser(
  path: string,
  pending?: ReturnView,
  options: {
    state?: unknown;
    calendar?: typeof api.getUserActivityCalendar;
    issues?: typeof api.listUserIssues;
  } = {},
) {
  const client = testQueryClient();
  client.setQueryData(userQuery("alice").queryKey, alice);
  const viewer = {
    ...alice,
    email: "alice@example.com",
    is_instance_admin: false,
  };
  client.setQueryData(meQuery.queryKey, viewer);
  client.setQueryData(referenceConfigQuery("alpha").queryKey, {
    format: { prefix: "A", history: [] },
    autolinks: [],
  });
  client.setQueryData<ReferenceDirectory>(referenceDirectoryQuery.queryKey, {
    entries: [],
    contested: [],
  });
  vi.spyOn(api, "me").mockResolvedValue(viewer);
  const calendar = vi
    .spyOn(api, "getUserActivityCalendar")
    .mockImplementation(
      options.calendar ?? (async (_subject, input) => userCalendar(input)),
    );
  vi.spyOn(api, "getUser").mockResolvedValue(alice);
  vi.spyOn(api, "listUserProjects").mockResolvedValue({ items: [] });
  const listUserIssues = vi.spyOn(api, "listUserIssues").mockImplementation(
    options.issues ??
      (async (_ref, query) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return USER_PAGES[String((query as Query)?.after ?? "first")];
      }),
  );

  const rootRoute = returnRoot(account(VIEWER));
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const userRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/users/$ref",
    validateSearch: userSearchSchema,
    component: appRouter.routesById["/authed/users/$ref"].options.component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([authedRoute.addChildren([userRoute])]),
    history: historyAt(path, { pending, state: options.state }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client, listUserIssues, calendar };
}

describe("the user page", () => {
  it("replays its one flat lane under the filters the URL carries", async () => {
    const view = mountUser(
      "/users/alice?role=assignee&state=all",
      snapshot({
        target: {
          kind: "user",
          ref: "alice",
          search: { role: "assignee", state: "all" },
        },
        userLabel: "alice",
        pages: [{ lane: "flat", extraPages: 2 }],
      }),
    );
    await settleUntil(
      () => rowIds(view.container).length === 3 && settled(view.router)(),
    );

    const asked = view.listUserIssues.mock.calls.map(([ref, query]) => ({
      ref,
      ...(query as Query),
    }));
    expect(asked).toEqual([
      { ref: "alice", role: "assignee", state: "all" },
      { ref: "alice", role: "assignee", state: "all", after: "u1" },
      { ref: "alice", role: "assignee", state: "all", after: "u2" },
    ]);
    expect(rowIds(view.container)).toEqual(["11", "12", "13"]);
    expect(entryOf(view.router).pending).toBeUndefined();
  });

  it("describes itself by the canonical login even when reached by id", async () => {
    const view = mountUser("/users/7");
    await settle(250);

    // A pointerdown is what freezes a snapshot before a click can become a
    // navigation, so this is the origin a row's link would carry. `/users/7`
    // replaces itself with `/users/alice`, and a target naming the id would
    // send the returning reader back through that redirect.
    act(() => {
      fireEvent.pointerDown(view.container);
    });
    const frozen = entryOf(view.router).view;
    expect(view.router.state.location.pathname).toBe("/users/alice");
    expect(frozen?.target).toEqual({ kind: "user", ref: "alice", search: {} });
    expect(frozen?.userLabel).toBe("alice");
  });

  it("captures date props in useReturnView and restores them after history serialization", async () => {
    const search = {
      role: "assignee" as const,
      state: "all" as const,
      activity_day: "2025-03-04",
    };
    const path = "/users/alice?role=assignee&state=all&activity_day=2025-03-04";
    const calendar = async (
      _subject: Parameters<typeof api.getUserActivityCalendar>[0],
      input: Parameters<typeof api.getUserActivityCalendar>[1],
    ) => userCalendar(input, true);
    const first = mountUser(path, undefined, { calendar });
    await settleUntil(
      () =>
        rowIds(first.container).includes("11") &&
        first.queryByText("calendar card") !== null,
    );
    expect(rowIds(first.container)).toEqual(["11"]);
    expect(first.getByText("u one")).toBeTruthy();
    expect(first.getByText("calendar card")).toBeTruthy();
    fireEvent.click(first.getByRole("button", { name: "Load more" }));
    await settleUntil(
      () => rowIds(first.container).includes("12") && settled(first.router)(),
    );
    expect(rowIds(first.container)).toEqual(["11", "12"]);
    expect(first.getByText("u two")).toBeTruthy();
    act(() => fireEvent.pointerDown(first.container));
    const captured = entryOf(first.router).view;
    // This assertion reads UserProfilePage's actual hook output. Copying URL
    // search into the harness's pending snapshot cannot satisfy it.
    expect(captured?.target).toEqual({ kind: "user", ref: "alice", search });
    expect(captured?.pages).toEqual([{ lane: "flat", extraPages: 1 }]);
    expect(captured).toBeDefined();
    writeReturnEntry(first.router, {
      pending: { view: captured as ReturnView, locate: true },
    });
    const state = JSON.parse(
      JSON.stringify(first.router.history.location.state),
    );
    first.unmount();
    const previousIssueCalls = first.listUserIssues.mock.calls.length;
    const restored = mountUser(path, undefined, { state, calendar });
    await settleUntil(
      () =>
        rowIds(restored.container).includes("12") && settled(restored.router)(),
    );
    expect(rowIds(restored.container)).toEqual(["11", "12"]);
    expect(restored.getByText("u two")).toBeTruthy();
    expect(entryOf(restored.router).pending).toBeUndefined();
    expect(restored.router.state.location.search).toEqual(search);
    // mountUser reuses the API spy, so only calls made by this mount count.
    expect(
      restored.listUserIssues.mock.calls.slice(previousIssueCalls),
    ).toEqual([
      ["alice", { role: "assignee", state: "all" }],
      ["alice", { role: "assignee", state: "all", after: "u1" }],
    ]);
    act(() => fireEvent.pointerDown(restored.container));
    expect(entryOf(restored.router).view?.target).toEqual({
      kind: "user",
      ref: "alice",
      search,
    });
  });

  it.each(["success", "empty", "error", "selected pending", "lazy"] as const)(
    "waits for calendar layout before restoring a card anchor: %s",
    async (outcome) => {
      const base = deferred<ActivityCalendarResponse>();
      const selected = deferred<ActivityCalendarResponse>();
      const moduleGate = deferred<void>();
      const scrollTo = vi
        .spyOn(window, "scrollTo")
        .mockImplementation(() => {});
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
        4000,
      );
      vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
      const search = {
        role: "assignee" as const,
        state: "all" as const,
        ...(outcome === "empty" ? {} : { activity_day: "2025-03-04" }),
      };
      if (outcome === "lazy") userCalendarModule.wait = moduleGate.promise;
      const pending = snapshot({
        target: { kind: "user", ref: "alice", search },
        scroll: [
          region({
            region: "window",
            y: 400,
            candidates: [{ id: "11", offset: 25 }],
          }),
        ],
      });
      const view = mountUser(
        `/users/alice?role=assignee&state=all${outcome === "empty" ? "" : "&activity_day=2025-03-04"}`,
        pending,
        {
          calendar: async (_subject, input) =>
            input.day ? selected.promise : base.promise,
        },
      );
      try {
        await view.findByText("u one");
        const row = view.container.querySelector<HTMLElement>(
          '[data-return-id="11"]',
        );
        expect(row).not.toBeNull();
        let top = 300;
        vi.spyOn(
          row as HTMLElement,
          "getBoundingClientRect",
        ).mockImplementation(
          () => ({ top, left: 0, bottom: top + 40, height: 40 }) as DOMRect,
        );
        await settle(150);
        expect(entryOf(view.router).pending?.locate).toBe(true);
        expect(restoreScrolls(scrollTo)).toEqual([]);
        if (outcome === "lazy") {
          expect(view.calendar).not.toHaveBeenCalled();
          await act(async () => {
            userCalendarModule.wait = null;
            moduleGate.resolve();
          });
        }
        await waitFor(() => expect(view.calendar).toHaveBeenCalled());
        const input = view.calendar.mock.calls[0]![1];
        const recorded =
          outcome === "success" ||
          outcome === "selected pending" ||
          outcome === "lazy";
        if (!recorded) top = 950;
        await act(async () => {
          if (outcome === "error")
            base.reject(new Error("calendar unavailable"));
          else base.resolve(userCalendar(input, recorded));
        });
        if (recorded) {
          await waitFor(() =>
            expect(view.calendar).toHaveBeenCalledWith(
              alice.id,
              expect.objectContaining({ day: "2025-03-04" }),
            ),
          );
          await settle(150);
          // The grid is now present, but the selected first-page list has not
          // settled. Measuring here would still anchor above the final rows.
          expect(entryOf(view.router).pending?.locate).toBe(true);
          expect(restoreScrolls(scrollTo)).toEqual([]);
          top = 950;
          await act(async () => {
            selected.resolve(
              userCalendar({ ...input, day: "2025-03-04" }, true),
            );
          });
          await view.findByText("calendar card");
        }
        await settleUntil(settled(view.router));
        expect(entryOf(view.router).pending).toBeUndefined();
        // Final row top minus the real fallback shell inset and saved offset.
        expect(restoreScrolls(scrollTo)).toEqual([{ top: 950 - 56 - 25 }]);
      } finally {
        userCalendarModule.wait = null;
        moduleGate.resolve();
        base.resolve(
          userCalendar({ from: "2025-01-01", to: "2026-01-01", tz: "UTC" }),
        );
        selected.resolve(
          userCalendar({ from: "2025-01-01", to: "2026-01-01", tz: "UTC" }),
        );
        view.unmount();
      }
    },
  );

  it("preserves the sampled user window during a stable warm calendar refresh", async () => {
    const refetch = deferred<void>();
    let refreshing = false;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
      4000,
    );
    vi.spyOn(window, "scrollY", "get").mockReturnValue(400);
    const search = {
      role: "assignee",
      state: "all",
      activity_day: "2025-03-04",
    };
    const view = mountUser(
      "/users/alice?role=assignee&state=all&activity_day=2025-03-04",
      undefined,
      {
        calendar: async (_subject, input) => {
          if (refreshing) await refetch.promise;
          return userCalendar(input, true);
        },
      },
    );
    try {
      await settleUntil(
        () =>
          view.queryByText("calendar card") !== null &&
          rowIds(view.container).includes("11") &&
          view.client.isFetching({ queryKey: ["activity-user"] }) === 0,
      );
      expect(rowIds(view.container)).toEqual(["11"]);
      expect(view.getByText("calendar card")).toBeTruthy();
      const row = view.container.querySelector<HTMLElement>(
        '[data-return-id="11"]',
      )!;
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: 200,
        left: 0,
        bottom: 240,
        height: 40,
      } as DOMRect);
      act(() => fireEvent.pointerDown(row));
      const before = entryOf(view.router).view;
      expect(before?.scroll).toEqual([
        {
          region: "window",
          x: 0,
          y: 400,
          candidates: [{ id: "11", offset: 144 }],
        },
      ]);
      refreshing = true;
      let finished!: Promise<void>;
      act(() => {
        finished = view.client.invalidateQueries({
          queryKey: ["activity-user"],
        });
      });
      await settleUntil(
        () =>
          view.container.querySelector('section[aria-busy="true"]') !== null,
      );
      expect(
        view.container.querySelector('section[aria-busy="true"]'),
      ).not.toBeNull();
      expect(
        view.client.isFetching({ queryKey: ["activity-user"] }),
      ).toBeGreaterThan(0);
      expect(rowIds(view.container)).toEqual(["11"]);
      expect(view.getByText("calendar card")).toBeTruthy();
      act(() => fireEvent.pointerDown(row));
      expect(entryOf(view.router).view?.scroll).toEqual(before?.scroll);
      expect(entryOf(view.router).view?.target).toEqual({
        kind: "user",
        ref: "alice",
        search,
      });
      expect(entryOf(view.router).pending).toBeUndefined();
      await act(async () => {
        refetch.resolve();
        await finished;
      });
      expect(restoreScrolls(scrollTo)).toEqual([]);
    } finally {
      refetch.resolve();
      view.unmount();
    }
  });

  it.each(["visible", "withdrawn"] as const)(
    "commits replayed user rows during a calendar refetch with %s layout",
    async (layout) => {
      const replay = deferred<UserIssuesPage>();
      const refetch = deferred<void>();
      let refreshing = false;
      const scrollTo = vi
        .spyOn(window, "scrollTo")
        .mockImplementation(() => {});
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
        4000,
      );
      vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
      const search = {
        role: "assignee" as const,
        state: "all" as const,
        activity_day: "2025-03-04",
      };
      const view = mountUser(
        "/users/alice?role=assignee&state=all&activity_day=2025-03-04",
        snapshot({
          target: { kind: "user", ref: "alice", search },
          pages: [{ lane: "flat", extraPages: 1 }],
          scroll: [
            region({
              region: "window",
              y: 400,
              candidates: [{ id: "11", offset: 25 }],
            }),
          ],
        }),
        {
          calendar: async (_subject, input) => {
            if (refreshing) await refetch.promise;
            return userCalendar(input, true);
          },
          issues: async (_ref, query) =>
            (query as Query)?.after === "u1"
              ? replay.promise
              : USER_PAGES.first!,
        },
      );
      try {
        await settleUntil(
          () =>
            view.queryByText("calendar card") !== null &&
            view.listUserIssues.mock.calls.some(
              ([, q]) => (q as Query)?.after === "u1",
            ) &&
            view.client.isFetching({ queryKey: ["activity-user"] }) === 0,
        );
        expect(rowIds(view.container)).toEqual(["11"]);
        expect(view.getByText("calendar card")).toBeTruthy();
        const row = view.container.querySelector<HTMLElement>(
          '[data-return-id="11"]',
        )!;
        vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
          top: 950,
          left: 0,
          bottom: 990,
          height: 40,
        } as DOMRect);
        expect(entryOf(view.router).pending?.locate).toBe(true);
        expect(restoreScrolls(scrollTo)).toEqual([]);
        refreshing = true;
        let finished!: Promise<void>;
        act(() => {
          finished =
            layout === "visible"
              ? view.client.invalidateQueries({ queryKey: ["activity-user"] })
              : view.client.resetQueries({ queryKey: ["activity-user"] });
        });
        await settleUntil(
          () => view.client.isFetching({ queryKey: ["activity-user"] }) > 0,
        );
        // Let the real Section commit its fetch state before the independent page response.
        if (layout === "withdrawn")
          await settleUntil(() => view.queryByText("calendar card") === null);
        else {
          await settleUntil(
            () =>
              view.container.querySelector('section[aria-busy="true"]') !==
              null,
          );
          expect(
            view.container.querySelector('section[aria-busy="true"]'),
          ).not.toBeNull();
        }
        expect(entryOf(view.router).pending?.locate).toBe(true);
        await act(async () => replay.resolve(USER_PAGES.u1!));
        await settleUntil(() => rowIds(view.container).includes("12"));
        expect(rowIds(view.container)).toEqual(["11", "12"]);
        expect(view.getByText("u two")).toBeTruthy();
        expect(view.listUserIssues.mock.calls).toEqual([
          ["alice", { role: "assignee", state: "all" }],
          ["alice", { role: "assignee", state: "all", after: "u1" }],
        ]);
        expect(
          view.client.isFetching({ queryKey: ["activity-user"] }),
        ).toBeGreaterThan(0);
        if (layout === "withdrawn") {
          expect(view.queryByText("calendar card")).toBeNull();
          await settle(100);
          expect(entryOf(view.router).pending?.locate).toBe(true);
          expect(restoreScrolls(scrollTo)).toEqual([]);
        } else {
          expect(view.getByText("calendar card")).toBeTruthy();
          await settleUntil(settled(view.router));
          expect(entryOf(view.router).pending).toBeUndefined();
          expect(restoreScrolls(scrollTo)).toEqual([{ top: 950 - 56 - 25 }]);
        }
        await act(async () => {
          refetch.resolve();
          await finished;
        });
        await settleUntil(
          () =>
            settled(view.router)() &&
            view.queryByText("calendar card") !== null,
        );
        expect(entryOf(view.router).pending).toBeUndefined();
        expect(rowIds(view.container)).toEqual(["11", "12"]);
        expect(view.router.state.location.search).toEqual(search);
        expect(restoreScrolls(scrollTo)).toEqual([{ top: 950 - 56 - 25 }]);
      } finally {
        replay.resolve(USER_PAGES.u1!);
        refetch.resolve();
        view.unmount();
      }
    },
  );

  it("still waits for card rows after the calendar has settled", async () => {
    const rows = deferred<UserIssuesPage>();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const view = mountUser(
      "/users/alice",
      snapshot({
        target: { kind: "user", ref: "alice", search: {} },
        scroll: [region({ region: "window", y: 400 })],
      }),
      { issues: async () => rows.promise },
    );
    await view.findByText(/No available dates in/);
    await settle(150);
    expect(entryOf(view.router).pending?.locate).toBe(true);
    expect(restoreScrolls(scrollTo)).toEqual([]);
    await act(async () => rows.resolve(USER_PAGES.first!));
    await view.findByText("u one");
    await settleUntil(settled(view.router));
    expect(entryOf(view.router).pending).toBeUndefined();
    expect(restoreScrolls(scrollTo)).toHaveLength(1);
  });
});

// ————— the inbox —————

const inboxItem = (
  id: number,
  title: string,
  over: Partial<InboxItem> = {},
): InboxItem => ({
  ...item(id, title, todo),
  project: { id: 1, slug: "alpha", name: "Alpha" },
  last_activity_at: "2026-09-01T00:00:00Z",
  pending_spec_review: false,
  mentions_you: false,
  unread: true,
  unread_comments: 1,
  ...over,
});

const INBOX: InboxPageData = {
  items: [
    inboxItem(41, "a comment"),
    inboxItem(42, "a spec", {
      unread_comments: 0,
      pending_spec_review: true,
      spec_version: 2,
      spec_review_status: "unreviewed",
    }),
  ],
  truncated: false,
  // Per-project totals arrived with T-382; the inbox page itself does not
  // read them, but the payload's shape is the payload's shape.
  unread_counts: { alpha: 2 },
};

function mountInbox({
  pending,
  path = "/inbox",
}: {
  pending?: ReturnView;
  path?: string;
} = {}) {
  vi.spyOn(api, "getInbox").mockResolvedValue(INBOX);
  vi.spyOn(api, "getReferenceDirectory").mockResolvedValue({
    entries: [],
    contested: [],
  });
  const client = testQueryClient();

  const rootRoute = returnRoot(account(VIEWER));
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    component: InboxPage,
  });
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug/issues/$number",
    component: () => <div>a card</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([inboxRoute, issueRoute]),
    history: historyAt(path, { pending }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

/** The word on the selected tab link. */
const selectedTab = (view: { getAllByRole: (role: string) => HTMLElement[] }) =>
  view
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

describe("the inbox tab carried by its URL", () => {
  it("restores the position on the tab named by the return URL", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const view = mountInbox({
      path: "/inbox?tab=specs",
      pending: snapshot({
        target: { kind: "inbox" },
        tab: "specs",
        scroll: [region({ region: "window", y: 320 })],
      }),
    });
    await settle(200);
    expect(selectedTab(view)).toBe("Specs");
    expect(rowIds(view.container)).toEqual(["42"]);
    // The restore ran to its end: the position was put back, and the entry
    // stopped advertising a target it no longer owes.
    expect(restoreScrolls(scrollTo)).toEqual([{ top: 0 }]);
    expect(entryOf(view.router).pending).toBeUndefined();
  });

  it("is All on a fresh visit from the shell", async () => {
    const view = mountInbox();
    await settle(200);

    expect(selectedTab(view)).toBe("All");
    expect(rowIds(view.container)).toEqual(["41", "42"]);
  });

  it("stays on the tab the reader picked when the rows refresh underneath", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const view = mountInbox({
      path: "/inbox?tab=specs",
      pending: snapshot({
        target: { kind: "inbox" },
        tab: "specs",
        scroll: [region({ region: "window", y: 320 })],
      }),
    });
    await settle(200);
    expect(selectedTab(view)).toBe("Specs");

    fireEvent.click(view.getByRole("tab", { name: "Comments" }));
    scrollTo.mockClear();
    // The background refresh the shell's event stream produces. A restore the
    // reader has taken over must be retired by then, not re-read from the
    // entry: it would put its own tab back and move the page under them.
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["inbox"] });
    });
    await settle(200);

    expect(selectedTab(view)).toBe("Comments");
    expect(rowIds(view.container)).toEqual(["41"]);
    expect(restoreScrolls(scrollTo)).toEqual([]);
    expect(entryOf(view.router).pending).toBeUndefined();
  });

  it("keeps a pending restore on modified tab clicks, but cancels on an ordinary click", async () => {
    // Hold the placement frame so the real restore remains pending while
    // the reader opens another tab; a completed restore cannot prove this.
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    const cancelRestore = vi.fn();
    const useCancelReturnRestore = returnContext.useCancelReturnRestore;
    vi.spyOn(returnContext, "useCancelReturnRestore").mockImplementation(() => {
      const cancel = useCancelReturnRestore();
      return () => {
        cancelRestore();
        cancel();
      };
    });
    const pending = snapshot({
      target: { kind: "inbox" },
      tab: "specs",
      scroll: [region({ region: "window", y: 320 })],
    });
    const view = mountInbox({ path: "/inbox?tab=specs", pending });
    await view.findByText("a spec");
    await settle();
    expect(entryOf(view.router).pending).toEqual({
      view: pending,
      locate: true,
    });
    const comments = view.getByRole("tab", { name: "Comments" });
    expect(comments.getAttribute("href")).toBe("/inbox?tab=comments");
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      fireEvent.pointerDown(comments, { [modifier]: true });
      fireEvent.click(comments, { [modifier]: true });
      await settle();
      expect.soft(cancelRestore, modifier).not.toHaveBeenCalled();
      expect.soft(entryOf(view.router).pending, modifier).toEqual({
        view: pending,
        locate: true,
      });
      expect(view.router.state.location.href).toBe("/inbox?tab=specs");
      expect(selectedTab(view)).toBe("Specs");
    }
    // Same callback and real registry: the unmodified gesture must cancel.
    fireEvent.click(comments);
    await settle();
    expect(cancelRestore).toHaveBeenCalledTimes(1);
    expect(entryOf(view.router).pending).toBeUndefined();
    expect(selectedTab(view)).toBe("Comments");
  });

  it("keeps the URL authoritative when history state remembers another tab", async () => {
    const view = mountInbox({
      path: "/inbox?tab=comments",
      pending: snapshot({ target: { kind: "inbox" }, tab: "specs" }),
    });
    await settle(200);
    expect(selectedTab(view)).toBe("Comments");
    expect(rowIds(view.container)).toEqual(["41"]);
    expect(view.router.state.location.search).toEqual({ tab: "comments" });
  });

  it("follows Back and Forward while snapshots are written on each entry", async () => {
    // happy-dom incorrectly truncates forward entries on replaceState.
    // The memory history here preserves the browser contract while the real
    // ReturnViewProvider still samples and rewrites the entries.
    const view = mountInbox({ path: "/inbox?tab=specs" });
    await settle(200);
    expect(selectedTab(view)).toBe("Specs");
    fireEvent.click(view.getByRole("tab", { name: "Comments" }));
    await settle(200);
    expect(selectedTab(view)).toBe("Comments");
    view.router.history.back();
    await settle(200);
    expect(selectedTab(view)).toBe("Specs");
    expect(view.router.state.location.search).toEqual({ tab: "specs" });
    view.router.history.forward();
    await settle(200);
    expect(selectedTab(view)).toBe("Comments");
    expect(view.router.state.location.search).toEqual({ tab: "comments" });
  });
});

// ————— the board —————

const BOARD_CARDS: Record<number, IssueListItem[]> = {
  2: [item(701, "todo card", todo), item(702, "another todo", todo)],
  5: [item(801, "next card", next)],
};

function mountBoard({
  statuses = [todo, next],
  pending,
}: {
  statuses?: Status[];
  pending?: ReturnView;
} = {}) {
  const client = testQueryClient();
  client.setQueryData(statusesQuery("alpha").queryKey, statuses);
  for (const status of statuses) {
    client.setQueryData(
      boardColumnQuery("alpha", status.id).queryKey,
      page(BOARD_CARDS[status.id] ?? [], null),
    );
  }
  client.setQueryData(referenceConfigQuery("alpha").queryKey, {
    format: { prefix: "T", history: [] },
    autolinks: [],
  });
  vi.spyOn(api, "listIssues").mockImplementation(async (_slug, query) => {
    const status = (query as Query)?.status;
    const id = Array.isArray(status) ? Number(status[0]) : 0;
    return page(BOARD_CARDS[id] ?? [], null);
  });

  const rootRoute = returnRoot(account(VIEWER));
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const boardRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "board",
    component: () => (
      <Suspense fallback={<div>loading board</div>}>
        <BoardPage />
      </Suspense>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectRoute.addChildren([boardRoute])]),
    ]),
    history: historyAt("/projects/alpha/board", { pending }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

/**
 * happy-dom lays nothing out, so every box has to say where it is: the columns
 * along x, the cards along y. That asymmetry is what lets the assertions below
 * tell the canvas's axis from a column's.
 */
function placeBoard(container: HTMLElement) {
  const canvas = container.querySelector<HTMLElement>(".overflow-x-auto");
  if (canvas === null) throw new Error("the board canvas is not on screen");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  const columns = [
    ...canvas.querySelectorAll<HTMLElement>(":scope > [data-return-id]"),
  ];
  for (const [index, column] of columns.entries()) {
    column.getBoundingClientRect = () =>
      ({ left: index * 300, top: 0 }) as DOMRect;
    const viewport = column.querySelector<HTMLElement>(".overflow-y-auto");
    if (viewport === null) continue;
    viewport.getBoundingClientRect = () => ({ left: 0, top: 100 }) as DOMRect;
    const cards = [
      ...viewport.querySelectorAll<HTMLElement>("[data-return-id]"),
    ];
    for (const [row, card] of cards.entries()) {
      card.getBoundingClientRect = () =>
        ({ left: 0, top: 100 + row * 60 }) as DOMRect;
    }
  }
  return canvas;
}

/**
 * Make the board's boxes scrollable. happy-dom reports every size as 0, and a
 * region with nothing to scroll clamps to the top however good the snapshot
 * is — so without this the restore side of the board cannot be observed here
 * at all. Installed on the prototype rather than on the elements, because the
 * restore measures within a frame or two of mount and there is no earlier
 * moment at which the column viewports exist.
 *
 * Sizes differ per axis on purpose: a restore that wrote the canvas's answer
 * into a column, or measured the wrong axis, lands on the other number.
 */
function makeBoardScrollable(): () => void {
  const proto = HTMLElement.prototype;
  const saved = (
    ["scrollWidth", "clientWidth", "scrollHeight", "clientHeight"] as const
  ).map(
    (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
  );
  const sizes: Record<string, number> = {
    scrollWidth: 900,
    clientWidth: 600,
    scrollHeight: 600,
    clientHeight: 300,
  };
  for (const [name] of saved) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        const horizontal = this.classList.contains("overflow-x-auto");
        const vertical = this.classList.contains("overflow-y-auto");
        if (name.includes("Width") && !horizontal) return 0;
        if (name.includes("Height") && !vertical) return 0;
        return sizes[name] ?? 0;
      },
    });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(proto, name);
      } else {
        Object.defineProperty(proto, name, descriptor);
      }
    }
  };
}

describe("the board registers one region per column and one for its canvas", () => {
  it("names the columns by status id along x, and the cards by issue id", async () => {
    const view = mountBoard();
    await settle(200);
    const canvas = placeBoard(view.container);
    canvas.scrollLeft = 220;

    // A pointerdown is what freezes a snapshot before a click can become a
    // navigation, so this is the sample a card's link would carry.
    act(() => {
      fireEvent.pointerDown(view.container);
    });
    const named = new Map(
      (entryOf(view.router).view?.scroll ?? []).map((s) => [s.region, s]),
    );

    expect([...named.keys()].sort()).toEqual([
      "board-canvas",
      "status:2",
      "status:5",
      "window",
    ]);
    // The canvas measures along x: its rows are the columns by status id, each
    // at its own horizontal offset. Measured on the y axis they would all sit
    // at 0, which is the shape of that mistake.
    expect(named.get("board-canvas")).toEqual({
      region: "board-canvas",
      x: 220,
      y: 0,
      candidates: [
        { id: "2", offset: 0 },
        { id: "5", offset: 300 },
      ],
    });
    // A column measures along y, and its rows are cards by DATABASE id — the
    // number is a per-project address that a move between projects rewrites.
    expect(named.get("status:2")?.candidates).toEqual([
      { id: "701", offset: 0 },
      { id: "702", offset: 60 },
    ]);
  });

  it("puts the canvas and the column back, not just the window", async () => {
    const undo = makeBoardScrollable();
    try {
      const view = mountBoard({
        pending: snapshot({
          target: { kind: "board", slug: "alpha" },
          // Two regions, two axes, two different numbers. The board row of the
          // acceptance table names "only saved window.scrollY" as the defect to
          // catch, and a window-only restore leaves both of these at 0.
          scroll: [
            region({ region: "board-canvas", x: 300, y: 0 }),
            region({ region: "status:5", y: 180 }),
          ],
        }),
      });
      await settleUntil(settled(view.router));

      const canvas =
        view.container.querySelector<HTMLElement>(".overflow-x-auto");
      const column = view.container
        .querySelector<HTMLElement>('[data-return-id="5"]')
        ?.querySelector<HTMLElement>(".overflow-y-auto");
      // The column's own scrolling element, which is the div OverlayScrollbars
      // adopts — writing to the decorative shell one level up would leave this
      // at 0 while looking like a restore.
      expect(canvas?.scrollLeft).toBe(300);
      expect(column?.scrollTop).toBe(180);
      // And not each other's: the canvas moves along x only, the column along y.
      expect(canvas?.scrollTop).toBe(0);
      expect(column?.scrollLeft).toBe(0);
    } finally {
      undo();
    }
  });

  it("skips a column the snapshot names but the board no longer has", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const view = mountBoard({
      pending: snapshot({
        target: { kind: "board", slug: "alpha" },
        scroll: [
          region({
            region: "status:999",
            y: 640,
            candidates: [{ id: "55", offset: 12 }],
          }),
          region({ region: "status:2", y: 120 }),
          region({ region: "window", y: 80 }),
        ],
      }),
    });
    await settle(250);

    // A column that has since been deleted is not a reason to abandon the
    // other regions: the restore finishes and stops advertising a target it
    // no longer owes.
    expect(entryOf(view.router).pending).toBeUndefined();
    expect(restoreScrolls(scrollTo)).toEqual([{ top: 0 }]);
  });
});
