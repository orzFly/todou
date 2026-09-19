import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type {
  Issue,
  MePrefs,
  ReferenceConfig,
  RefPlacement,
} from "@todou/shared";
import { type ReactNode, Suspense, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSearchSchema } from "../src/api/issues.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { searchPageSchema } from "../src/api/search.ts";
import { userSearchSchema } from "../src/api/users.ts";
import { IssueReturnRow } from "../src/components/issue/issue-return-row.tsx";
import { ReturnViewProvider } from "../src/components/shared/return-context.tsx";
import {
  RETURN_VIEW_VERSION,
  type ReturnTarget,
  type ReturnView,
  returnLabelOf,
} from "../src/lib/return-view.ts";
import { writeReturnEntry } from "../src/lib/return-view-history.ts";
import { useScrollInsets } from "../src/lib/scroll-insets.ts";
import { IssueDetailPage } from "../src/pages/issue-detail.tsx";
import { render, renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "p";

/** The account the page mount at the bottom of this file answers /api/me with. */
const pageUser = {
  id: 7,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const LONG_TITLE =
  "a title long enough that the bar has to truncate it somewhere";

const prefixedConfig: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

const issue = {
  id: 16,
  number: 16,
  title: LONG_TITLE,
  body: "",
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
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
  created_at: "2026-08-28T00:00:00Z",
  updated_at: "2026-08-28T00:00:00Z",
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
} satisfies Issue;

/** The last observer's callback, so a test can drive the threshold. */
let notify: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
let observerOptions: IntersectionObserverInit | undefined;

class FakeIntersectionObserver {
  constructor(
    callback: (entries: Array<{ isIntersecting: boolean }>) => void,
    options?: IntersectionObserverInit,
  ) {
    notify = callback;
    observerOptions = options;
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function seededClient(
  config: ReferenceConfig = prefixedConfig,
  detail: RefPlacement = "before",
): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery(SLUG).queryKey, config);
  client.setQueryData(prefsQuery.queryKey, {
    show_weak_unread: true,
    // The bar follows the detail page, and nothing else (T-157).
    ref_placement_list: "after",
    ref_placement_board: "own_line",
    ref_placement_detail: detail,
    ref_placement_reference: "after",
    boxed_ref_links: true,
    truncate_ref_title: true,
    show_repeated_ref_title: false,
  } satisfies MePrefs);
  return client;
}

function Harness({ mirror }: { mirror?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={ref}>the real title block</div>
      <IssueReturnRow
        slug={SLUG}
        issue={issue}
        watchTarget={ref}
        mirror={mirror}
      />
    </>
  );
}

async function renderBar(config?: ReferenceConfig, detail?: RefPlacement) {
  const { container } = renderWithProviders(
    <Harness />,
    seededClient(config, detail),
  );
  const view = within(container);
  const bar = await view.findByTestId("floating-title-bar");
  return { view, bar };
}

/** Cross the threshold: `true` = the real title is back in view. */
const setIntersecting = (isIntersecting: boolean) =>
  act(() => notify?.([{ isIntersecting }]));

/**
 * happy-dom answers 0 from every `getBoundingClientRect()`, so a height only
 * reaches the hook when it is stubbed on the element. use-header-height.test.ts
 * stubs the same way.
 */
function headerOf(height: number): HTMLElement {
  const header = document.createElement("header");
  header.getBoundingClientRect = () => ({ height }) as DOMRect;
  document.body.append(header);
  return header;
}

beforeEach(() => {
  notify = undefined;
  observerOptions = undefined;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  // testing-library removes only the container it made, and the stub is
  // appended beside it.
  for (const header of document.querySelectorAll("header")) header.remove();
});

describe("IssueReturnRow (T-154)", () => {
  it("appears once the real title scrolls past the shell header", async () => {
    const { bar } = await renderBar();
    expect(bar.dataset.state).toBe("hidden");

    setIntersecting(false);
    expect(bar.dataset.state).toBe("shown");

    setIntersecting(true);
    expect(bar.dataset.state).toBe("hidden");
  });

  it("offsets the threshold and the bar by the header's measured height", async () => {
    headerOf(97);
    const { bar } = await renderBar();
    // `useHeaderHeight` reports from a passive effect, so the second render's
    // DOM commits while the observer still holds the fallback. Read
    // synchronously, this case would pass against a hard-coded 56 — the defect
    // it exists to catch (T-237). `waitFor` flushes that effect, and the
    // observer is rebuilt with the measurement.
    await waitFor(() => {
      expect(observerOptions?.rootMargin).toBe("-97px 0px 0px 0px");
      expect(bar.closest<HTMLElement>(".sticky")?.style.top).toBe("97px");
    });
  });

  it("stands on a 56px offset until there is a header to measure", async () => {
    await renderBar();
    expect(observerOptions?.rootMargin).toBe("-56px 0px 0px 0px");
  });

  it("stays hidden from assistive tech in both states", async () => {
    const { bar } = await renderBar();
    expect(bar.getAttribute("aria-hidden")).toBe("true");

    setIntersecting(false);
    expect(bar.getAttribute("aria-hidden")).toBe("true");
  });

  it.each(["before", "after"] as const)(
    "keeps the ref out of the truncating span with ref_placement_detail=%s",
    async (detail) => {
      const { view, bar } = await renderBar(undefined, detail);
      const ref = await view.findByText("T-16");
      const title = await view.findByText(LONG_TITLE);

      // Siblings inside the mirror rather than children of it: the identity
      // is its own shared component now (T-407). What has to hold is that the
      // ref sits beside the truncating span and not in it, whichever order
      // the reader's preference puts them in.
      expect(bar.contains(ref)).toBe(true);
      expect(ref.parentElement).toBe(title.parentElement);
      expect(title.contains(ref)).toBe(false);
      expect(title.className).toContain("truncate");
      expect(ref.className).toContain("shrink-0");
    },
  );

  it("puts the ref ahead of the title by default (T-153)", async () => {
    const { view } = await renderBar();
    const ref = await view.findByText("T-16");
    const title = await view.findByText(LONG_TITLE);
    expect(
      ref.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("puts the ref after the title when the detail page does", async () => {
    const { view } = await renderBar(undefined, "after");
    const ref = await view.findByText("T-16");
    const title = await view.findByText(LONG_TITLE);
    expect(
      title.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("spells the ref in the project's format", async () => {
    const { view } = await renderBar({
      format: { prefix: null, history: [] },
      autolinks: [],
    });
    expect(await view.findByText("#16")).toBeTruthy();
  });

  it("scrolls back to the top when clicked", async () => {
    const { bar } = await renderBar();
    setIntersecting(false);

    fireEvent.click(bar);
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
  });

  it("renders inert where IntersectionObserver is missing", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { bar } = await renderBar();
    await waitFor(() => expect(bar.dataset.state).toBe("hidden"));
  });
});

const VIEWER = 7;

function originOf(
  target: ReturnTarget,
  over: Partial<ReturnView> = {},
): ReturnView {
  return {
    v: RETURN_VIEW_VERSION,
    userId: VIEWER,
    snapshotId: "s1",
    target,
    pages: [],
    scroll: [],
    ...over,
  };
}

/**
 * The row on an issue entry that carries an origin, seeded through the
 * writer a detail navigation itself uses. Written before the mount because
 * the provider reads the entry it is standing on during its first render.
 *
 * Its own router rather than the shim's: the destinations under test are the
 * five collection routes, and their `validateSearch` is what decides the
 * canonical URL a back link has to rebuild.
 */
function renderWithOrigin(
  origin: ReturnView | undefined,
  { viewerId = VIEWER }: { viewerId?: number } = {},
) {
  const rootRoute = createRootRoute();
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const listRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    validateSearch: (search: Record<string, unknown>) =>
      issueSearchSchema.parse(search),
  });
  const boardRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "board",
  });
  const searchRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "search",
    validateSearch: (search: Record<string, unknown>) =>
      searchPageSchema.parse(search),
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => (
      <ReturnViewProvider viewerId={viewerId}>
        <Harness />
      </ReturnViewProvider>
    ),
  });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
  });
  const userRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/users/$ref",
    validateSearch: userSearchSchema,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      inboxRoute,
      userRoute,
      projectRoute.addChildren([
        listRoute,
        boardRoute,
        searchRoute,
        issueRoute,
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/projects/${SLUG}/issues/16`],
    }),
  });
  if (origin !== undefined) writeReturnEntry(router, { origin });
  return render(
    <QueryClientProvider client={seededClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** `el` and every element above it, for asking what a subtree inherits. */
function ancestors(el: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let at: HTMLElement | null = el; at !== null; at = at.parentElement) {
    chain.push(at);
  }
  return chain;
}

const named = (el: HTMLElement) =>
  el.dataset.testid ?? el.tagName.toLowerCase();

/** The page as issue-detail.tsx assembles it: the row is one of its insets. */
function InsetHarness() {
  const title = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  useScrollInsets({ top: [row] });
  return (
    <>
      <div ref={title}>the real title block</div>
      <IssueReturnRow
        slug={SLUG}
        issue={issue}
        watchTarget={title}
        rowRef={row}
      />
    </>
  );
}

describe("the way back (T-407, T-461)", () => {
  it("carries a copy of the control the heading took away with it", async () => {
    const { view, bar } = await renderBar();
    // Since T-461 the real control travels with the title block, so this row
    // holds nothing until the title has gone — and must hold the way back
    // from that moment on, or a reader who has scrolled has none at all.
    expect(bar.dataset.state).toBe("hidden");

    const link = await view.findByRole("link", {
      name: "Back to Issues",
      hidden: true,
    });
    expect(link.tagName).toBe("A");
    // Resolved at render, so it can be previewed, middle-clicked and
    // bookmarked without following it first.
    expect(link.getAttribute("href")).toBe("/projects/p");
    // Sized to the title it stands beside, which in this bar is the compact
    // one — the heading's copy is two steps larger.
    expect(link.dataset.slot).toBe("button");
    expect(link.dataset.variant).toBe("ghost");
    expect(link.dataset.size).toBe("icon-xs");
    // The word it used to carry is the accessible name now and nothing else:
    // the title beside it already says where this card is.
    expect(link.textContent).toBe("");
  });

  it("rides inside the mirror, which is what makes it a copy", async () => {
    const { view } = await renderBar();
    const hiding = (link: HTMLElement) =>
      ancestors(link)
        .filter(
          (el) => el.hasAttribute("aria-hidden") || el.hasAttribute("inert"),
        )
        .map(named);

    const link = await view.findByRole("link", {
      name: "Back to Issues",
      hidden: true,
    });
    // Inside the `aria-hidden` half on purpose (T-461): the document still
    // holds the real one up by the heading, reachable by tab and by screen
    // reader whether or not it is in view, and announcing both would offer
    // the same journey twice.
    expect(hiding(link)).toEqual(["floating-title-bar"]);
    // Inert as well until the bar is shown, so it never sits in the tab order
    // of a bar nobody can see — and not inert once it is.
    const bar = link.closest("[data-testid='floating-title-bar']");
    expect(bar?.hasAttribute("inert")).toBe(true);
    setIntersecting(false);
    expect(hiding(link)).toEqual(["floating-title-bar"]);
    expect(bar?.hasAttribute("inert")).toBe(false);
  });

  it("does not answer its own click by scrolling to the top", async () => {
    const { view, bar } = await renderBar();
    const link = await view.findByRole("link", {
      name: "Back to Issues",
      hidden: true,
    });

    setIntersecting(false);
    fireEvent.click(link);
    // The two halves share one row, so the failure mode is one inheriting the
    // other's handler: back would send the reader to the top of the card they
    // are leaving instead of to the list. Asserted against the mirror's exact
    // call rather than against `scrollTo` having run at all, because the
    // router resets the scroll of the page it navigates to — `{left: 0,
    // top: 0}`, no behaviour — and that one is not this row's doing.
    expect(window.scrollTo).not.toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });

    fireEvent.click(bar);
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
  });

  it("leaves nothing focusable behind while the mirror is hidden", async () => {
    const { container } = renderWithProviders(
      <Harness mirror={<button type="button">Reveal all</button>} />,
      seededClient(),
    );
    const view = within(container);
    const bar = await view.findByTestId("floating-title-bar");
    // Faded rather than unmounted, which is what makes anything necessary
    // here at all: the control is in the DOM at both ends of the threshold.
    expect(within(bar).getByText("Reveal all")).toBeTruthy();

    // `aria-hidden` has already taken it out of the accessibility tree, so
    // what is left to go wrong is the tab order — and happy-dom has no tab
    // order to walk. `inert` is the attribute a browser reads for it, and
    // therefore the assertable form of the promise.
    expect(bar.hasAttribute("inert")).toBe(true);
    setIntersecting(false);
    expect(bar.hasAttribute("inert")).toBe(false);
  });

  it("hands its own height to the page's scroll insets", async () => {
    headerOf(56);
    const { container } = renderWithProviders(<InsetHarness />, seededClient());
    const row = await within(container).findByTestId("issue-return-row");
    // happy-dom lays nothing out, so the row's `h-10` only reaches the hook
    // when the element itself answers with it.
    row.getBoundingClientRect = () => ({ height: 40 }) as DOMRect;
    act(() => window.dispatchEvent(new Event("resize")));

    // Keep clearance for the mirror even while its wide-screen host takes
    // no space, so a jump from the page top cannot land behind it.
    expect(document.documentElement.style.scrollPaddingTop).toBe("104px");
  });
});

/** Label, accessible name and canonical URL, per the entry matrix on T-407. */
const ENTRIES: [
  what: string,
  origin: ReturnView,
  label: string,
  name: string,
  href: string,
][] = [
  [
    "project list wearing every filter",
    originOf({
      kind: "list",
      slug: "todou",
      search: {
        q: "guard",
        category: "all",
        status: "1,2",
        assignee: 4,
        sort: "updated",
        order: "asc",
        group: "none",
      },
    }),
    "Issues",
    "Back to Issues",
    "/projects/todou?q=guard&category=all&status=1%2C2&assignee=4&sort=updated&order=asc&group=none",
  ],
  [
    "trash, which is the list route in a mode of its own",
    originOf({ kind: "list", slug: "todou", search: { deleted: true } }),
    "Trash",
    "Back to Trash",
    "/projects/todou?deleted=true",
  ],
  [
    "board",
    originOf({ kind: "board", slug: "todou" }),
    "Board",
    "Back to Board",
    "/projects/todou/board",
  ],
  [
    "search, compatibility field and all",
    originOf({
      kind: "search",
      slug: "todou",
      search: { q: "guard", in: "comments,specs" },
    }),
    "Search",
    "Back to Search",
    "/projects/todou/search?q=guard&in=comments%2Cspecs",
  ],
  ["inbox", originOf({ kind: "inbox" }), "Inbox", "Back to Inbox", "/inbox"],
  [
    "user page, across projects",
    originOf(
      {
        kind: "user",
        ref: "alice",
        search: { role: "assignee", state: "closed" },
      },
      { userLabel: "alice" },
    ),
    "User",
    // The one entry whose word does not identify its destination, so the
    // accessible name names the person instead.
    "Back to alice",
    "/users/alice?role=assignee&state=closed",
  ],
];

describe("where the way back goes (T-407)", () => {
  it.each(ENTRIES)(
    "returns to the %s",
    async (_what, origin, label, name, href) => {
      const view = renderWithOrigin(origin);
      const link = await view.findByRole("link", { name, hidden: true });
      // Nothing on screen says the word any more (T-461), so the column that
      // used to be the visible label is pinned where it still decides
      // something: the accessible name is built out of it. The user entry is
      // the exception the matrix already documents — it names the person.
      expect(returnLabelOf(origin.target)).toBe(label);
      expect(link.textContent).toBe("");
      // The styled slot must reach the anchor for remembered origins too.
      expect(link.dataset.slot).toBe("button");
      expect(link.dataset.variant).toBe("ghost");
      expect(link.dataset.size).toBe("icon-xs");
      expect(link.classList.contains("inline-flex")).toBe(true);
      expect(link.classList.contains("whitespace-nowrap")).toBe(true);
      // Exactly this, with nothing appended: the snapshot rides the
      // navigation as history state, so a new tab opened from here lands on
      // the same filters and no reading position.
      expect(link.getAttribute("href")).toBe(href);
    },
  );

  it("says User where the account behind the page has not landed", async () => {
    const view = renderWithOrigin(
      originOf({ kind: "user", ref: "alice", search: {} }),
    );
    const link = await view.findByRole("link", {
      name: "Back to User",
      hidden: true,
    });
    expect(link.getAttribute("href")).toBe("/users/alice");
  });

  it("falls back to this project's list where there is no origin", async () => {
    // A new tab, an external link, a bookmark and a pasted address all arrive
    // at an entry holding nothing, and all four land here.
    const view = renderWithOrigin(undefined);
    const link = await view.findByRole("link", {
      name: "Back to Issues",
      hidden: true,
    });
    expect(link.getAttribute("href")).toBe(`/projects/${SLUG}`);
  });

  it("refuses an origin another account left on this entry", async () => {
    const view = renderWithOrigin(originOf({ kind: "inbox" }), {
      viewerId: VIEWER + 1,
    });
    // A history entry outlives a logout; the next reader must not be handed
    // the previous one's inbox.
    const link = await view.findByRole("link", {
      name: "Back to Issues",
      hidden: true,
    });
    expect(link.getAttribute("href")).toBe(`/projects/${SLUG}`);
  });
});

/**
 * The page's own wiring, mounted for real.
 *
 * The inset case above proves the row reports its height to whatever hook is
 * given its ref; it cannot prove `issue-detail.tsx` hands that ref over. Only
 * the page can answer that, so this mounts it — the row is on screen at every
 * scroll position, and a comment permalink that lands underneath it is the
 * failure (T-299, T-407).
 */
describe("the page declares the return row as a top overlay", () => {
  const ROW_HEIGHT = 40;

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  /** Enough of the API for the page to reach its first paint. */
  function stubApi() {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/me")) return json(pageUser);
      if (url.endsWith("/api/projects")) {
        return json([{ id: 1, slug: SLUG, name: SLUG }]);
      }
      if (url.includes("/references/config")) {
        return json({ format: { prefix: "T", history: [] }, autolinks: [] });
      }
      if (url.includes("/reference-directory")) {
        return json({ entries: [], contested: [], slug_entries: [] });
      }
      if (url.includes("/prefs")) return json({});
      if (url.includes("/metadata")) return json({ namespaces: {} });
      if (url.includes("/timeline")) {
        return json({ items: [], prev_cursor: null, next_cursor: null });
      }
      if (/\/issues\/\d+$/.test(url)) return json(issue);
      // Before the project match below, which would otherwise answer these
      // with the project object and leave the page calling `.filter` on it.
      if (url.endsWith("/statuses") || url.endsWith("/labels")) return json([]);
      if (url.includes("/attachments")) return json([]);
      if (url.endsWith("/members")) {
        return json([
          {
            user: pageUser,
            role: "writer",
            created_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (url.includes(`/projects/${SLUG}`) && !url.includes("/issues")) {
        return json({ id: 1, slug: SLUG, name: SLUG, viewer_role: "writer" });
      }
      return json([]);
    }) as unknown as typeof fetch);
  }

  /**
   * happy-dom measures every box as 0, so the row has to say how tall it is
   * before the page's layout effect reads it. On the prototype because the
   * measurement happens in the same commit the row first renders in.
   */
  function giveTheRowHeight(): () => void {
    const proto = HTMLElement.prototype;
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function measured(this: HTMLElement) {
      const height =
        this.dataset.testid === "issue-return-row" ? ROW_HEIGHT : 0;
      return { height, top: 0, left: 0, width: 0 } as DOMRect;
    };
    return () => {
      proto.getBoundingClientRect = original;
    };
  }

  it("counts the row's height into the page's scroll padding", async () => {
    const undo = giveTheRowHeight();
    try {
      stubApi();
      const client = testQueryClient();
      // The provider sits inside the router, where the shell puts it: it
      // reads the current history entry, so it cannot be mounted above one.
      const rootRoute = createRootRoute({
        component: () => (
          <ReturnViewProvider viewerId={VIEWER}>
            <Outlet />
          </ReturnViewProvider>
        ),
      });
      const authedRoute = createRoute({
        getParentRoute: () => rootRoute,
        id: "authed",
      });
      const projectRoute = createRoute({
        getParentRoute: () => authedRoute,
        path: "/projects/$slug",
      });
      const issueRoute = createRoute({
        getParentRoute: () => projectRoute,
        path: "issues/$number",
        component: () => (
          <Suspense fallback={<div>loading</div>}>
            <IssueDetailPage />
          </Suspense>
        ),
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([
          authedRoute.addChildren([projectRoute.addChildren([issueRoute])]),
        ]),
        history: createMemoryHistory({
          initialEntries: [`/projects/${SLUG}/issues/${issue.number}`],
        }),
      });
      const view = render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await view.findByTestId("issue-return-row");

      // 8px of breathing room plus the row. Without the page passing its ref,
      // this reads 8px — the row would be on screen and the anchors would land
      // behind it.
      await waitFor(() => {
        expect(document.documentElement.style.scrollPaddingTop).toBe(
          `${ROW_HEIGHT + 8}px`,
        );
      });
    } finally {
      undo();
      vi.unstubAllGlobals();
    }
  });
});
