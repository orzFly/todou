import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clearReturnMemory } from "../src/lib/return-view-history.ts";
import { registerDirtySource } from "../src/lib/unsaved-guard.ts";
import { router } from "../src/router.tsx";
import {
  renderOnTheAppRouter,
  restoreAppRouterPage,
  teardownAppRouter,
} from "./app-router.tsx";
import { testQueryClient } from "./render.tsx";

/**
 * T-407 end to end: a reader opens a card from a collection page, and the back
 * control puts them back on that exact collection.
 *
 * Every case here drives the application's own singleton router over the real
 * browser history, from a real entry. The origin rides a real navigation as
 * history state, so a shim router handed a `state` prop by the test would stay
 * green with the `state=` wiring deleted from every link in the app — which is
 * precisely the regression these tests exist to catch.
 */

const ME = {
  id: 9,
  login: "reader",
  display_name: "Reader",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const ALICE = {
  id: 3,
  login: "alice",
  display_name: "Alice Liu",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
};

const DEMO = {
  id: 1,
  slug: "demo",
  name: "Demo",
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  viewer_role: "writer" as const,
  former_slugs: [],
  icon_url: null,
};
const OTHER = { ...DEMO, id: 2, slug: "other", name: "Other" };

const TODO = {
  id: 1,
  name: "Todo",
  category: "open" as const,
  color: "#6b7280",
  position: 0,
  is_default: true,
};
const DOING = { ...TODO, id: 2, name: "Doing", position: 1, is_default: false };

const AUTHOR = {
  id: ME.id,
  login: ME.login,
  display_name: ME.display_name,
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

type Row = {
  id: number;
  number: number;
  title: string;
  slug: string;
  status: typeof TODO;
  spec?: boolean;
  deleted?: boolean;
  blockedBy?: number;
};

const DIG: Row = {
  id: 101,
  number: 11,
  title: "Dig up the potatoes",
  slug: "demo",
  status: TODO,
  spec: true,
  blockedBy: 12,
};
const WASH: Row = {
  id: 102,
  number: 12,
  title: "Wash the potatoes",
  slug: "demo",
  status: DOING,
};
const TRASHED: Row = {
  id: 104,
  number: 14,
  title: "A discarded card",
  slug: "demo",
  status: TODO,
  deleted: true,
};
const ELSEWHERE: Row = {
  id: 201,
  number: 3,
  title: "A card in the other project",
  slug: "other",
  status: TODO,
};

/** Still listed at its old address, whose GET answers 301 (an automatic move). */
const MOVED: Row = {
  id: 103,
  number: 13,
  title: "The card that was moved away",
  slug: "demo",
  status: TODO,
};

const ROWS = [DIG, WASH, MOVED, TRASHED, ELSEWHERE];

function listItem(row: Row) {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    author: AUTHOR,
    assignees: [],
    labels: [],
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    body_edited_at: null,
    open_questions: 1,
    spec_version: row.spec === true ? 3 : null,
    spec_review_status: row.spec === true ? "unreviewed" : null,
    spec_unresolved_comments: 0,
    deleted_at: row.deleted === true ? "2026-03-01T00:00:00Z" : null,
    deleted_by: row.deleted === true ? AUTHOR : null,
    unread: false,
    unread_comments: 2,
    muted: null,
    blocked_by:
      row.blockedBy === undefined
        ? []
        : [
            {
              edge_id: 1,
              project_id: 1,
              project: "demo",
              number: row.blockedBy,
              ref: `T-${row.blockedBy}`,
              hidden: false,
              cleared_at: null,
              blocker_deleted: false,
            },
          ],
    blocks: [],
    moves: [],
    project: {
      slug: row.slug,
      name: row.slug === "demo" ? "Demo" : "Other",
      icon_url: null,
    },
  };
}

const SPEC_INFO = {
  current_version: 3,
  current_version_cursor: "c3",
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [
    { path: "a.md", size: 30 },
    { path: "b.md", size: 30 },
  ],
  versions: [1, 2, 3].map((number) => ({
    number,
    author: AUTHOR,
    message: `v${number}`,
    created_at: "2026-02-02T00:00:00Z",
  })),
};

const specFiles = (version: number) => ({
  version,
  files: [
    { path: "a.md", body: `# The first file, v${version}\n`, size: 24 },
    { path: "b.md", body: `# The second file, v${version}\n`, size: 25 },
  ],
});

const MOVE_RESULT = {
  moved_to: { slug: "other", number: ELSEWHERE.number },
  reinhabited: false,
  mapping: {
    status: { from: "Todo", to: "Todo" },
    dropped_labels: [],
    dropped_assignees: [],
  },
  issue: null,
};

type Reply = { status: number; body: unknown };

const NOT_FOUND = (what: string): Reply => ({
  status: 404,
  body: { error: { code: "not_found", message: `fixture missing ${what}` } },
});

/**
 * A stand-in for the whole API, so every page of a round trip renders from
 * data rather than from a skeleton: a page that never gets past its skeleton
 * reports itself not ready, and a restore then waits forever instead of going
 * wrong in a way a test could see.
 */
function appFixture() {
  const answer = (raw: string, method: string): Reply => {
    const url = new URL(raw, "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    const slug = /^\/projects\/([^/]+)/.exec(path)?.[1] ?? "demo";

    // Both the dry run and the move itself: the dialog previews the mapping,
    // then navigates to what the second call reports.
    if (path.endsWith("/move")) return { status: 200, body: MOVE_RESULT };
    if (method !== "GET") return { status: 200, body: {} };

    if (path === "/me") return { status: 200, body: ME };
    if (path === "/version") return { status: 200, body: { version: "test" } };
    if (path === "/auth/mode") return { status: 200, body: { mode: "local" } };
    if (path === "/projects") return { status: 200, body: [DEMO, OTHER] };
    if (path === "/me/prefs") return { status: 200, body: {} };
    if (path === "/me/mutes") {
      return { status: 200, body: { issues: [], projects: [] } };
    }
    if (path === "/me/reference-directory") {
      return {
        status: 200,
        body: { entries: [], contested: [], slug_entries: [] },
      };
    }
    if (path === "/me/inbox") {
      return {
        status: 200,
        body: {
          items: [
            {
              ...listItem(DIG),
              last_activity_at: "2026-03-01T00:00:00Z",
              pending_spec_review: true,
              mentions_you: true,
            },
          ],
          truncated: false,
          unread_counts: { demo: 1 },
        },
      };
    }
    if (path === "/users/alice") return { status: 200, body: ALICE };
    if (path === "/users/alice/issues") {
      return {
        status: 200,
        body: {
          items: [listItem(ELSEWHERE)],
          next_cursor: null,
          has_more: false,
        },
      };
    }
    if (path === "/users/alice/projects")
      return { status: 200, body: { items: [] } };
    if (/^\/projects\/[^/]+$/.test(path)) {
      return { status: 200, body: slug === "other" ? OTHER : DEMO };
    }
    if (path.endsWith("/references/config")) {
      return {
        status: 200,
        body: { format: { prefix: "T", history: [] }, autolinks: [] },
      };
    }
    if (path.endsWith("/statuses")) return { status: 200, body: [TODO, DOING] };
    if (path.endsWith("/labels") || path.endsWith("/members")) {
      return { status: 200, body: [] };
    }
    if (path.endsWith("/search/facets")) {
      return { status: 200, body: { harnesses: [], sessions: [] } };
    }
    if (path.endsWith("/search")) {
      return {
        status: 200,
        body: {
          items: [
            {
              kind: "issue",
              issue: { number: DIG.number, title: DIG.title, status: TODO },
              comment_id: null,
              spec_path: null,
              field: "title",
              snippet: { text: DIG.title, ranges: [] },
              hidden: false,
              updated_at: "2026-02-01T00:00:00Z",
            },
            {
              kind: "spec",
              issue: { number: DIG.number, title: DIG.title, status: TODO },
              comment_id: null,
              spec_path: "b.md",
              field: "body",
              snippet: { text: "the second file", ranges: [] },
              hidden: false,
              updated_at: "2026-02-01T00:00:00Z",
            },
          ],
          has_more: false,
          diagnostics: [],
        },
      };
    }
    if (path.endsWith("/issues/counts")) {
      return {
        status: 200,
        body: { open: 2, closed: 0, by_status: { "1": 1, "2": 1 } },
      };
    }
    if (/\/issues$/.test(path)) {
      const deleted = url.searchParams.get("deleted") !== null;
      const wanted = url.searchParams.get("status");
      const ids =
        wanted === null ? null : new Set(wanted.split(",").map(Number));
      const items = ROWS.filter(
        (row) =>
          row.slug === slug &&
          (row.deleted === true) === deleted &&
          (ids === null || ids.has(row.status.id)),
      );
      return {
        status: 200,
        body: { items: items.map(listItem), next_cursor: null },
      };
    }
    const card = /^\/projects\/([^/]+)\/issues\/(\d+)$/.exec(path);
    if (card) {
      const number = Number(card[2]);
      // The address a card has moved away from: the client turns a 301 with
      // `moved_to` into the MovedError the issue route redirects on.
      if (card[1] === "demo" && number === MOVED.number) {
        return {
          status: 301,
          body: { moved_to: { slug: "other", number: ELSEWHERE.number } },
        };
      }
      const row = ROWS.find((r) => r.slug === card[1] && r.number === number);
      if (row === undefined) return NOT_FOUND(path);
      return {
        status: 200,
        body: { ...listItem(row), body: `About ${row.title}.` },
      };
    }
    if (path.endsWith("/timeline")) {
      return {
        status: 200,
        body: {
          items: [],
          prev_cursor: null,
          next_cursor: null,
          has_more: false,
          total_count: 0,
        },
      };
    }
    if (path.endsWith("/attachments")) return { status: 200, body: [] };
    if (path.endsWith("/metadata") || path.endsWith("/metadata/namespaces")) {
      return { status: 200, body: { entries: [], namespaces: [] } };
    }
    if (path.endsWith("/spec")) return { status: 200, body: SPEC_INFO };
    if (path.endsWith("/spec/files")) {
      return {
        status: 200,
        body: specFiles(Number(url.searchParams.get("version") ?? 3)),
      };
    }
    if (path.endsWith("/spec/comments")) {
      return { status: 200, body: { current_version: 3, items: [] } };
    }
    return NOT_FOUND(path);
  };

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;
    const reply = answer(raw, init?.method ?? "GET");
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });

  return { fetch };
}

/** happy-dom ships no ResizeObserver, and the list's sticky-offset effect
 * constructs one unconditionally. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mount = () => renderOnTheAppRouter(testQueryClient());

/**
 * Put the browser on `url`: a real entry to start from.
 *
 * The promise is deliberately dropped rather than awaited, for the reason
 * `startAtDraftPage` gives — the singleton router carries the previous test's
 * settling work, and an awaited navigate can hang past any timeout. The
 * delay only saves a poll cycle; every assertion below waits on the page.
 */
function startAt(url: string) {
  void router
    .navigate({ href: url, replace: true, ignoreBlocker: true })
    .catch(() => undefined);
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** A second, pushed entry — what the reader clicking a link would produce. */
function pushTo(url: string) {
  void router
    .navigate({ href: url, ignoreBlocker: true })
    .catch(() => undefined);
  return new Promise((resolve) => setTimeout(resolve, 50));
}

const addressBar = () =>
  `${window.location.pathname}${window.location.search}${window.location.hash}`;

/**
 * The origin is history state and nothing else: a copied address, a bookmark
 * and a shared permalink must not carry one. Asserted on the real address bar
 * rather than on the router's parsed search, which would not see a stray hash.
 */
function expectNoOriginInTheAddress() {
  expect(addressBar()).not.toMatch(/todouReturn|snapshotId|returnTo/i);
  expect(window.location.hash).not.toMatch(/todouReturn|snapshotId/i);
}

/**
 * The back control of the card named by `title`, taken out of the row it lives
 * in.
 *
 * Both halves of that are load-bearing. The heading is waited for first
 * because the router keeps the previous page mounted while the next one
 * suspends, and the row read a moment too early belongs to the card the reader
 * has just left. The row scopes the query because the trash page carries a
 * "Back to issues" link of its own, which a bare role query would find on the
 * page being left rather than the one being arrived at.
 */
async function backLinkOn(title: string): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: new RegExp(title) });
  const row = screen.getByTestId("issue-return-row");
  return within(row).getByRole("link", { name: /^Back to / });
}

/**
 * How a reader actually opens a card. The press matters: the entry is sampled
 * on `pointerdown`, before the click can become a navigation, so a test that
 * dispatched the click alone would be freezing whatever snapshot happened to
 * be in hand rather than the page as it stands.
 */
function openWithTheMouse(element: HTMLElement, init: MouseEventInit = {}) {
  fireEvent.pointerDown(element, {
    button: 0,
    pointerType: "mouse",
    ...init,
  });
  fireEvent.click(element, init);
}

/** Where the router ended up, waited for — a navigation is asynchronous. */
async function landedOn(pathname: string) {
  await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
}

/**
 * What this feature has written into the entry the reader is standing on.
 *
 * Read straight out of the browser's own history state under the one
 * namespaced key the module owns, rather than through the app's reader: the
 * claim being checked is *where* the origin lives, and a helper that parsed it
 * would go on agreeing if it moved into the URL.
 */
function entryNow(): {
  view?: { snapshotId: string; target: unknown; tab?: string };
  origin?: { snapshotId: string; target: unknown; tab?: string };
} {
  const state = window.history.state as Record<string, unknown> | null;
  const held = state === null ? undefined : state.todouReturn;
  return (held ?? {}) as ReturnType<typeof entryNow>;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.stubGlobal("fetch", appFixture().fetch);
});

afterEach(() => {
  cleanup();
  restoreAppRouterPage();
  clearReturnMemory();
  vi.unstubAllGlobals();
});

afterAll(teardownAppRouter);

describe("the project list", () => {
  const FILTERS = {
    q: "potato",
    category: "all",
    status: "1,2",
    label: "10,11",
    assignee: 3,
    sort: "created",
    order: "asc",
    group: "none",
  };

  /**
   * The defect this row exists for is a back link that keeps the path and
   * drops the filters: it satisfies a pathname check and still leaves the
   * reader looking at a different list. So every field is named here.
   */
  it("comes back to every filter the card was opened from", async () => {
    await startAt(
      "/projects/demo?q=potato&category=all&status=1,2&label=10,11&assignee=3&sort=created&order=asc&group=none",
    );
    mount();

    openWithTheMouse(await screen.findByRole("link", { name: DIG.title }));
    const back = await backLinkOn(DIG.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Issues");
    // Where the origin is: this card's own history entry, under one key, with
    // the card's address itself carrying none of it.
    expect(entryNow().origin?.target).toEqual({
      kind: "list",
      slug: "demo",
      search: FILTERS,
    });
    expect(addressBar()).toBe("/projects/demo/issues/11");
    fireEvent.click(back);

    await landedOn("/projects/demo");
    expect(router.state.location.search).toEqual(FILTERS);
    expect([...new URLSearchParams(window.location.search)].sort()).toEqual(
      [
        ["assignee", "3"],
        ["category", "all"],
        ["group", "none"],
        ["label", "10,11"],
        ["order", "asc"],
        ["q", "potato"],
        ["sort", "created"],
        ["status", "1,2"],
      ].sort(),
    );
    expectNoOriginInTheAddress();
  });

  it("calls the trash the Trash, and returns to the deleted list", async () => {
    await startAt("/projects/demo?deleted=1");
    mount();

    openWithTheMouse(await screen.findByRole("link", { name: TRASHED.title }));
    const back = await backLinkOn(TRASHED.title);
    expect(back.textContent).toContain("Trash");
    expect(back.getAttribute("aria-label")).toBe("Back to Trash");
    fireEvent.click(back);

    await landedOn("/projects/demo");
    expect(new URLSearchParams(window.location.search).get("deleted")).toBe(
      "1",
    );
    // The trash view, not the ordinary list that shares this address.
    expect(await screen.findByRole("heading", { name: "Trash" })).toBeTruthy();
    expectNoOriginInTheAddress();
  });
});

describe("the board", () => {
  /**
   * Reading the list first is the whole point: a "last collection this project
   * was read through" cache answers Issues here, and only the board's own
   * history entry can answer Board.
   */
  it("returns to the board even for a reader who read the list first", async () => {
    await startAt("/projects/demo");
    mount();
    await screen.findByRole("link", { name: DIG.title });

    fireEvent.click(
      (await screen.findAllByRole("link", { name: "Board" }))[0] as HTMLElement,
    );
    // The board's own column, so the card clicked below is the board's and not
    // the list row still on screen while the board loads.
    await screen.findByTestId("column-Doing");
    openWithTheMouse(await screen.findByRole("link", { name: WASH.title }));

    const back = await backLinkOn(WASH.title);
    expect(back.textContent).toContain("Board");
    expect(back.getAttribute("aria-label")).toBe("Back to Board");
    fireEvent.click(back);

    await landedOn("/projects/demo/board");
    expect(window.location.search).toBe("");
    expectNoOriginInTheAddress();
  });
});

describe("search", () => {
  const SEARCH_URL =
    "/projects/demo/search?q=potato&in=issues,specs&status=1&label=10&assignee=3";

  // The card's own header row, which the hit rows below repeat the title of —
  // hence the index rather than a name that would match either.
  const titleHit = async () =>
    (
      await screen.findAllByRole("link", {
        name: /Dig up the potatoes/,
      })
    )[0] as HTMLElement;

  it("keeps q and the legacy in on the way back", async () => {
    await startAt(SEARCH_URL);
    mount();

    openWithTheMouse(await titleHit());
    const back = await backLinkOn(DIG.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Search");
    fireEvent.click(back);

    await landedOn("/projects/demo/search");
    expect(router.state.location.search).toEqual({
      q: "potato",
      in: "issues,specs",
      status: "1",
      label: "10",
      assignee: 3,
    });
    expectNoOriginInTheAddress();
  });

  /**
   * A spec hit opens the spec itself, and the spec's control always goes to
   * its own issue first. A spec page that returned straight to the results —
   * one step instead of two — is what this walks over.
   */
  it("takes a spec hit back through its own issue, never straight to the results", async () => {
    await startAt(SEARCH_URL);
    mount();

    openWithTheMouse(
      await screen.findByRole("link", { name: /the second file/ }),
    );
    await landedOn("/projects/demo/issues/11/spec");

    fireEvent.click(await screen.findByRole("link", { name: "Back to Issue" }));
    await landedOn("/projects/demo/issues/11");

    const toSearch = await backLinkOn(DIG.title);
    expect(toSearch.getAttribute("aria-label")).toBe("Back to Search");
    fireEvent.click(toSearch);

    await landedOn("/projects/demo/search");
    expect(router.state.location.search).toMatchObject({
      q: "potato",
      in: "issues,specs",
    });
  });
});

describe("the spec page's own moves", () => {
  /** A file switch is a navigation of its own, and must carry the origin. */
  it("keeps the list reachable across a file switch", async () => {
    await startAt("/projects/demo?category=all&group=none");
    mount();
    openWithTheMouse(await screen.findByRole("link", { name: DIG.title }));
    await landedOn("/projects/demo/issues/11");

    openWithTheMouse(await screen.findByRole("link", { name: "a.md" }));
    await landedOn("/projects/demo/issues/11/spec");

    fireEvent.click((await screen.findAllByTitle("b.md"))[0] as HTMLElement);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ file: "b.md" }),
    );

    // And a version switch, the page's other everyday move: both rewrite this
    // page's own search params, which is exactly where an origin carried as
    // `state` beside them is easiest to drop.
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "viewing v3, switch version" }),
      { button: 0, pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /v2/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        v: 2,
        file: "b.md",
      }),
    );

    fireEvent.click(await screen.findByRole("link", { name: "Back to Issue" }));
    await landedOn("/projects/demo/issues/11");
    const back = await backLinkOn(DIG.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Issues");
    fireEvent.click(back);

    await landedOn("/projects/demo");
    expect(router.state.location.search).toEqual({
      category: "all",
      group: "none",
    });
  });
});

describe("the inbox", () => {
  const TABS = ["All", "Mentions", "Comments", "Specs", "Questions"] as const;

  for (const tab of TABS) {
    it(`comes back to the ${tab} tab through its URL`, async () => {
      await startAt("/inbox");
      mount();

      fireEvent.click(await screen.findByRole("tab", { name: tab }));
      const search = tab === "All" ? "" : `?tab=${tab.toLowerCase()}`;
      await waitFor(() => expect(window.location.search).toBe(search));
      openWithTheMouse(await screen.findByRole("link", { name: DIG.title }));

      const back = await backLinkOn(DIG.title);
      expect(back.getAttribute("aria-label")).toBe("Back to Inbox");
      expect(back.getAttribute("href")).toBe(`/inbox${search}`);
      fireEvent.click(back);

      await landedOn("/inbox");
      await waitFor(() =>
        expect(
          screen.getByRole("tab", { name: tab }).getAttribute("aria-selected"),
        ).toBe("true"),
      );
      expect(window.location.search).toBe(search);
      expectNoOriginInTheAddress();
    });
  }

  it.each(["mentions", "comments", "specs", "questions", "all", "bogus"])(
    "validates a direct tab=%s URL on the real route without rewriting it",
    async (tab) => {
      await startAt(`/inbox?tab=${tab}`);
      mount();
      const selected =
        tab === "bogus" ? "All" : tab[0]?.toUpperCase() + tab.slice(1);
      await waitFor(() =>
        expect(
          screen
            .getByRole("tab", { name: selected })
            .getAttribute("aria-selected"),
        ).toBe("true"),
      );
      expect(window.location.search).toBe(`?tab=${tab}`);
      const match = router.state.matches.at(-1);
      expect(match?.routeId).toBe("/authed/inbox");
      // TanStack retains raw search on matches; exercise the registered
      // validator itself as well as the page reached through that route.
      const validate = router.routesById["/authed/inbox"].options
        .validateSearch as (search: Record<string, unknown>) => unknown;
      expect(validate({ tab })).toEqual(
        tab === "all" || tab === "bogus" ? {} : { tab },
      );
      expect(screen.getByRole("link", { name: DIG.title })).toBeTruthy();
    },
  );

  it("follows browser Back between reason tabs", async () => {
    await startAt("/inbox?tab=mentions");
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: "Comments" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?tab=comments");
      expect(
        screen
          .getByRole("tab", { name: "Comments" })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(router.state.status).toBe("idle");
    });
    router.history.back();
    await waitFor(() => {
      expect(window.location.search).toBe("?tab=mentions");
      expect(
        screen
          .getByRole("tab", { name: "Mentions" })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(router.state.status).toBe("idle");
    });
  });
});

describe("a user page", () => {
  /**
   * The card lives in another project, so a back link assembled from the card
   * rather than from the entry lands on that project's list instead.
   */
  it("returns to the user's own filtered page, not the card's project", async () => {
    await startAt("/users/alice?role=author&state=all");
    mount();

    openWithTheMouse(
      await screen.findByRole("link", { name: ELSEWHERE.title }),
    );
    await landedOn("/projects/other/issues/3");

    const back = await backLinkOn(ELSEWHERE.title);
    expect(back.getAttribute("aria-label")).toBe("Back to alice");
    expect(back.textContent).toContain("User");
    fireEvent.click(back);

    await landedOn("/users/alice");
    expect(router.state.location.search).toEqual({
      role: "author",
      state: "all",
    });
    expectNoOriginInTheAddress();
  });
});

describe("a card opened with no origin at all", () => {
  /**
   * The entry behind this one is what tells a real fallback apart from a
   * `history.back()`: stepping back would land on /projects. The index is
   * asserted too — going back cannot add an entry, and following the link
   * must.
   */
  it("offers the project's default list, with an unrelated entry behind it", async () => {
    await startAt("/projects");
    mount();
    await pushTo("/projects/demo/issues/11");

    const back = await backLinkOn(DIG.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Issues");
    expect(back.getAttribute("href")).toBe("/projects/demo");
    const index = router.history.location.state.__TSR_index;
    fireEvent.click(back);

    await landedOn("/projects/demo");
    expect(window.location.search).toBe("");
    expect(router.history.location.state.__TSR_index).toBe(index + 1);
  });

  /** Having read the board earlier must not become a remembered origin. */
  it("still offers the default list after the reader has been on the board", async () => {
    await startAt("/projects/demo/board");
    mount();
    await screen.findByRole("link", { name: WASH.title });

    await pushTo("/projects/demo/issues/11");

    const back = await backLinkOn(DIG.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Issues");
    expect(back.getAttribute("href")).toBe("/projects/demo");
    fireEvent.click(back);
    await landedOn("/projects/demo");
  });
});

describe("a chain of cards", () => {
  /** Card B was reached from card A; the way back is still the list. */
  it("returns to the list the chain started from, not to the card in between", async () => {
    await startAt("/projects/demo?category=all&group=none");
    mount();

    openWithTheMouse(await screen.findByRole("link", { name: DIG.title }));
    await landedOn("/projects/demo/issues/11");

    // The blocker section's reference to card B — a link the reader follows
    // mid-sentence, not a row of a collection.
    openWithTheMouse(
      await screen.findByRole("link", { name: /Wash the potatoes/ }),
    );
    await landedOn("/projects/demo/issues/12");

    const back = await backLinkOn(WASH.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Issues");
    fireEvent.click(back);

    await landedOn("/projects/demo");
    expect(router.state.location.search).toEqual({
      category: "all",
      group: "none",
    });
  });

  it("gives card B its own project's list when card A had no origin", async () => {
    await startAt("/projects");
    mount();
    await pushTo("/projects/demo/issues/11");
    await backLinkOn(DIG.title);

    openWithTheMouse(
      await screen.findByRole("link", { name: /Wash the potatoes/ }),
    );
    await landedOn("/projects/demo/issues/12");

    const back = await backLinkOn(WASH.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Issues");
    expect(back.getAttribute("href")).toBe("/projects/demo");
  });
});

describe("a modified click", () => {
  /**
   * Ctrl-clicking a row is the reader stacking tabs: the browser opens the
   * bare href, this page stays where it is, and the snapshot it offers is
   * untouched. A handler that pushed an entry or consumed the snapshot anyway
   * would strand whoever kept reading here.
   */
  it("opens nothing, pushes no entry, and leaves the origin on offer", async () => {
    await startAt("/projects/demo?q=potato&group=none&category=all");
    mount();
    const row = await screen.findByRole("link", { name: DIG.title });
    // The plain href is what the new tab gets: filters may ride the URL, an
    // origin never does.
    expect(row.getAttribute("href")).toBe("/projects/demo/issues/11");

    const index = router.history.location.state.__TSR_index;
    openWithTheMouse(row, { ctrlKey: true });
    openWithTheMouse(row, { metaKey: true });

    expect(router.state.location.pathname).toBe("/projects/demo");
    expect(router.history.location.state.__TSR_index).toBe(index);
    expect(entryNow().view?.target).toEqual({
      kind: "list",
      slug: "demo",
      search: { q: "potato", category: "all", group: "none" },
    });

    // And the plain click that follows still carries the same list.
    openWithTheMouse(row);
    fireEvent.click(await backLinkOn(DIG.title));
    await landedOn("/projects/demo");
    expect(router.state.location.search).toEqual({
      q: "potato",
      category: "all",
      group: "none",
    });
  });
});

describe("a card that moved", () => {
  /**
   * `issue-route-error` replaces the entry the reader arrived on, and a
   * replace drops whatever that entry held — so the origin has to be written
   * again, or following a link to a moved card costs the reader their way
   * back.
   */
  it("keeps the origin through the automatic redirect", async () => {
    await startAt("/projects/demo?category=all&group=none");
    mount();

    openWithTheMouse(await screen.findByRole("link", { name: MOVED.title }));
    await landedOn("/projects/other/issues/3");

    const back = await backLinkOn(ELSEWHERE.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Issues");
    fireEvent.click(back);
    await landedOn("/projects/demo");
    expect(router.state.location.search).toEqual({
      category: "all",
      group: "none",
    });
  });

  it("keeps the origin through a move the reader performs", async () => {
    await startAt("/projects/demo?category=all&group=none");
    mount();
    openWithTheMouse(await screen.findByRole("link", { name: DIG.title }));
    await landedOn("/projects/demo/issues/11");

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "More actions" }),
      { button: 0, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Move to another project/ }),
    );
    fireEvent.click(await screen.findByText("Other"));
    // The confirm button exists — disabled — while the dry run is still out,
    // and a click on it then does nothing at all.
    await screen.findByText(/its previous number there/);
    fireEvent.click(
      await screen.findByRole("button", { name: "Move to other" }),
    );

    await landedOn("/projects/other/issues/3");
    const back = await backLinkOn(ELSEWHERE.title);
    expect(back.getAttribute("aria-label")).toBe("Back to Issues");
    fireEvent.click(back);
    await landedOn("/projects/demo");
    expect(router.state.location.search).toEqual({
      category: "all",
      group: "none",
    });
  });
});

describe("the unsaved-changes guard", () => {
  /**
   * The back control is an ordinary router navigation, so it meets the guard
   * like every other one — and cancelling leaves the reader on the card with
   * the way back still on offer.
   */
  it("stands between the reader and the list, and cancelling keeps the card", async () => {
    await startAt("/projects/demo?category=all&group=none");
    mount();
    openWithTheMouse(await screen.findByRole("link", { name: DIG.title }));
    await landedOn("/projects/demo/issues/11");

    const dirty = registerDirtySource(() => true);
    try {
      fireEvent.click(await backLinkOn(DIG.title));

      expect(
        await screen.findByText("Leave with unsaved changes?"),
      ).toBeTruthy();
      expect(router.state.location.pathname).toBe("/projects/demo/issues/11");

      fireEvent.keyDown(await screen.findByText("Keep editing"), {
        key: "Escape",
        code: "Escape",
      });
      await waitFor(() =>
        expect(screen.queryByText("Leave with unsaved changes?")).toBeNull(),
      );
      expect(router.state.location.pathname).toBe("/projects/demo/issues/11");
      expect(await backLinkOn(DIG.title)).toBeTruthy();
    } finally {
      dirty();
    }
  });
});
