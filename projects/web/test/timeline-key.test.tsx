import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type {
  TimelineComment,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueDetailPage } from "../src/pages/issue-detail.tsx";
import { IssueRouteError } from "../src/pages/issue-route-error.tsx";
import {
  ProjectLayout,
  ProjectRouteError,
} from "../src/pages/project-layout.tsx";
import { cmCount } from "./cm.ts";
import { testQueryClient } from "./render.tsx";

/**
 * The key on `Timeline` (T-324), asserted against the real issue page.
 *
 * `issue-detail.tsx` is the only place that key exists, so a test that builds
 * its own `Timeline` cannot fail when that line is taken out — it would keep
 * passing while `spec-comment-card.tsx` and `questions-card.tsx`, which still
 * read their card from a closure, stand unprotected. These go through
 * `IssueDetailPage` on the real route instead, so deleting the key fails them.
 *
 * The route ids matter: the page and the layout read their params from
 * `/authed/projects/$slug/issues/$number`, so the pathless `authed` route has
 * to be here (the same shape `project-gate.test.tsx` uses).
 */

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (id: number, body: string): TimelineComment => ({
  type: "comment",
  id,
  author: user,
  body,
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const page = (list: TimelineItem[]): TimelinePage => ({
  items: list,
  prev_cursor: null,
  next_cursor: "c1",
  total_count: list.length,
});

/** Enough rows on a card for the editor and pill cases to have something to
 *  act on. Both cards carry a comment with the same id, which is what the row
 *  key — and therefore the key on `Timeline` — sees. */
const cardItems = (card: number) =>
  Array.from({ length: 6 }, (_, i) =>
    comment(i + 1, `card ${card} comment ${i + 1}`),
  );

/**
 * A folded card: the tail holds the newest comments and reports a `prev_cursor`,
 * so `Timeline` fetches a head the tail does not already cover. That leaves
 * `above` non-empty with a `remaining` gap — the shape the prepend
 * compensation at `timeline.tsx:139` exists for.
 */
const headItems = (card: number) => [comment(101, `card ${card} head comment`)];
const tailItems = (card: number) =>
  [2, 3].map((id) => comment(id, `card ${card} comment ${id}`));

const issue = (number: number) => ({
  id: number,
  number,
  title: `Card ${number}`,
  body: "",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author: user,
  assignees: [],
  labels: [],
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Every reply the page and its column ask for on their way to rendering. */
function stubPage({ folded = false }: { folded?: boolean } = {}): void {
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/me")) return json(user);
    // `/api/projects` itself has to answer before the `/projects/p` match
    // below, which would otherwise shadow it.
    if (url.endsWith("/api/projects")) {
      return json([{ id: 1, slug: "p", name: "p" }]);
    }
    if (url.includes("/attachments")) return json([]);
    if (url.includes("/metadata")) return json({ namespaces: {} });
    if (url.includes("/prefs")) return json({});
    if (url.includes("/references/config")) {
      return json({ format: { prefix: "T", history: [] }, autolinks: [] });
    }
    if (url.includes("/reference-directory")) {
      return json({ entries: [], contested: [], slug_entries: [] });
    }
    if (url.includes("/timeline")) {
      const card = Number(/issues\/(\d+)\/timeline/.exec(url)?.[1]);
      if (!folded) return json(page(cardItems(card)));
      // The head request carries no `last` and no cursor; the tail asks for
      // the newest page. A total above what either side holds is what leaves
      // the gap the fold block stands for.
      const isHead = !url.includes("last=1") && !/before=|after=/.test(url);
      const items = isHead ? headItems(card) : tailItems(card);
      return json({
        items,
        prev_cursor: isHead ? null : "p1",
        next_cursor: "c1",
        total_count: 40,
      } satisfies TimelinePage);
    }
    if (/\/issues\/\d+$/.test(url)) {
      return json(issue(Number(/issues\/(\d+)$/.exec(url)?.[1])));
    }
    if (url.endsWith("/labels") || url.endsWith("/statuses")) return json([]);
    if (url.endsWith("/members")) {
      return json([
        { user, role: "writer", created_at: "2026-01-01T00:00:00Z" },
      ]);
    }
    if (/\/projects\/\w+\/read$/.test(url)) return json(null);
    if (url.includes("/projects/p")) {
      return json({ id: 1, slug: "p", name: "p", viewer_role: "writer" });
    }
    return json([]);
  }) as unknown as typeof fetch);
}

/** The real layout and error boundaries over the real page. */
function renderAt(url: string) {
  const client = testQueryClient();
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    errorComponent: () => <div>handled above the project layer</div>,
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: ProjectLayout,
    errorComponent: ProjectRouteError,
  });
  const issuesRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => (
      <Suspense fallback={<div>loading</div>}>
        <IssueDetailPage />
      </Suspense>
    ),
    errorComponent: IssueRouteError,
    staticData: { resolvesProjectMiss: true },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectRoute.addChildren([issuesRoute])]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

type View = ReturnType<typeof renderAt>;

/**
 * `unstubAllGlobals` covers `vi.stubGlobal` only. The geometry spies
 * (`scrollY`, `innerHeight`, `documentElement.scrollHeight`) and the
 * `scrollTo` / `scrollBy` ones are not the config's to restore — the vitest
 * config sets no `restoreMocks`, and `setup.ts` reinstalls `fetch` alone — so a
 * case added below one that mocks them would otherwise inherit its numbers.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Navigate the way an in-app link does: through the router, not a reload. */
async function goToCard(view: View, number: number, marker?: string) {
  await view.router.navigate({
    to: "/projects/$slug/issues/$number",
    params: { slug: "p", number: String(number) },
  });
  await waitFor(() =>
    expect(
      within(view.container).getByText(marker ?? `card ${number} comment 1`),
    ).toBeTruthy(),
  );
}

/**
 * Stand on each card once before the case proper, so the case's own final move
 * lands on a card whose timeline is already cached. A row is only reusable when
 * the destination's data is there: on a cold one the queries go pending,
 * `Timeline` returns its skeleton, and every row unmounts with nothing to do
 * with the key. Warming is what makes those cases be about the key rather than
 * about a cache miss — which is the opposite of what the pill case needs, so it
 * warms by hand and leaves its own destination cold.
 */
async function warmBothCards(view: View) {
  await goToCard(view, 8);
  await goToCard(view, 7);
}

describe("the issue page's timeline, keyed by card", () => {
  it("does not carry an open editor across to the next card", async () => {
    stubPage();
    const view = renderAt("/projects/p/issues/7");
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-comment-id]").length).toBe(
        6,
      ),
    );
    await warmBothCards(view);
    // The page always mounts the composer's editor, so a row's is the delta.
    const composerEditors = cmCount(view.container);

    fireEvent.click(
      within(view.container).getAllByLabelText(
        "edit comment",
      )[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(cmCount(view.container)).toBe(composerEditors + 1),
    );

    await goToCard(view, 8);

    // Card 8 is on screen and the row editor is gone: the instance that held it
    // did not survive the change. Unkeyed, the row is reused on its `comment-1`
    // key and this editor stays open over the next card.
    expect(cmCount(view.container)).toBe(composerEditors);
  });

  it("does not announce the card it just left as new content", async () => {
    stubPage();
    const pill = () => within(view.container).queryByText("新消息") !== null;
    const view = renderAt("/projects/p/issues/7");
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-comment-id]").length).toBe(
        6,
      ),
    );

    // Warm card 8 by navigating to it and back, which is also how the page is
    // left standing on 7. The first 7→8 is a cold jump and on the broken path
    // it raises the pill by itself — harmless here only because the reader is
    // still at the bottom, where the effect takes its `scrollToBottom` branch
    // instead.
    await goToCard(view, 8);
    await goToCard(view, 7);

    // Put the reader away from the bottom and let the component's own scroll
    // listener record it: at the bottom the same effect calls `scrollToBottom`
    // instead, and the pill could not appear even on the broken path.
    vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
      10_000,
    );
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    fireEvent.scroll(window);
    // Everything above is setup, and it left no pill for the case to inherit:
    // the moves so far landed on cards whose timeline was already in the cache.
    expect(pill()).toBe(false);

    await goToCard(view, 9);

    // This move lands on a card with nothing cached, so `items` goes empty for a
    // render. Unkeyed, `lastKey` goes `comment-6 → null` while
    // `prevLastKey.current` is still `comment-6` — the guard passes, the reader
    // is not at the bottom, and the pill is raised. The later `null →
    // comment-6` is the transition the guard skips, so nothing clears it again.
    //
    // A cold destination is what this case rests on, and it is the one thing
    // here that a change to the setup could quietly take away: warming card 9
    // the way card 8 is warmed above would leave no empty render on this move
    // and the assertion would hold on both paths.
    expect(pill()).toBe(false);
  });

  it("still lands on the newest entry when the route reaches the next card", async () => {
    stubPage();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const DOC_HEIGHT = 5_000;
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
      DOC_HEIGHT,
    );
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
    const view = renderAt("/projects/p/issues/7");
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-comment-id]").length).toBe(
        6,
      ),
    );
    await warmBothCards(view);
    scrollTo.mockClear();

    await goToCard(view, 8);

    // `didInitialScroll` is a ref, so a remount is the only thing that resets
    // it. That scroll is this one, by its exact arguments — `scrollToBottom()`
    // asks for the document's end. The router also scrolls to the top on
    // arrival, so counting calls would mix the two; assert the landing instead.
    // Unkeyed the ref is already true and this call never happens.
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(scrollTo.mock.calls).toContainEqual([0, DOC_HEIGHT]);
  });
});

/**
 * The one cost of the key that is a behaviour change rather than a repair, and
 * the reason the key needed its own verification.
 *
 * `prevAboveCount` and `lastScrollHeight` are refs, so a remount is the only
 * thing that zeroes them. A fresh instance whose head is already cached commits
 * with items above the seam against a `lastScrollHeight` of 0, and the prepend
 * compensation at `timeline.tsx:139` then asks for a scroll equal to the whole
 * document. On the usual arrival the preceding scroll-to-bottom hides it and
 * the browser clamps the overshoot; when a `#comment-<id>` anchor owns the
 * viewport, `revealBlock` runs later in a passive effect and settles the
 * position — measured in a browser, a permalink into a folded card lands on its
 * target and holds there, so the overshoot is not observable at the end state.
 *
 * Pinned rather than asserted-away: these are the numbers the key produces
 * today, so a change to them is noticed here rather than rediscovered in a
 * browser.
 */
describe("the key's own cost on a folded card", () => {
  it("asks for a full-document scroll once the remount has zeroed its refs", async () => {
    stubPage({ folded: true });
    const view = renderAt("/projects/p/issues/7");
    await waitFor(() =>
      expect(
        within(view.container).getByText("card 7 head comment"),
      ).toBeTruthy(),
    );
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    // happy-dom has no layout, so `scrollHeight` is 0 and the compensation
    // would never run at all — the geometry has to be supplied. A folded card is
    // a document far taller than the viewport.
    const DOC_HEIGHT = 5_000;
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
      DOC_HEIGHT,
    );
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(0);

    // Visit card 8 first so both its sides are cached: remounting onto a card
    // that still has to fetch renders the skeleton and never reaches the
    // compensation, which is what keeps this from firing on every cold arrival.
    await goToCard(view, 8, "card 8 head comment");
    await goToCard(view, 7, "card 7 head comment");
    scrollBy.mockClear();

    await goToCard(view, 8, "card 8 head comment");

    const amounts = scrollBy.mock.calls.map((call) => call[1] as number);
    expect(amounts).toContain(DOC_HEIGHT);
  });
});
