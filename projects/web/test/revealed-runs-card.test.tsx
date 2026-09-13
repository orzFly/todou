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
import { StrictMode, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueDetailPage } from "../src/pages/issue-detail.tsx";
import { IssueRouteError } from "../src/pages/issue-route-error.tsx";
import {
  ProjectLayout,
  ProjectRouteError,
} from "../src/pages/project-layout.tsx";
import { testQueryClient } from "./render.tsx";

/**
 * The revealed-run state is the page's, not the card's (T-327): switching cards
 * has to fold every gap back.
 *
 * Asserted against the real page, never against a `RevealedRunsProvider` built
 * here. The reset only works where the card reaches the provider, and that
 * wiring lives in one line of `issue-detail.tsx`; a case that mounts the
 * provider itself keeps passing with that line deleted, which is exactly the
 * failure mode `comment-hidden.test.tsx` cannot see. These cases therefore go
 * through `IssueDetailPage` on the real route tree — the same argument, and the
 * same shape, as `timeline-key.test.tsx`.
 *
 * Strict Mode wraps the tree, as `main.tsx` does in development. Resetting from
 * inside the provider is this design's whole risk (T-317 lost that bet on the
 * `Composer`), so every case below exercises the double render rather than
 * trusting it.
 */

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (
  id: number,
  body: string,
  hidden = false,
): TimelineComment => ({
  type: "comment",
  id,
  author: user,
  body,
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: hidden ? "2026-09-08T11:00:00Z" : null,
  agent_context: null,
});

/**
 * Three cards over two projects, chosen so each of the two leaks is reachable
 * through its own path and neither case can be answered by the other's:
 *
 * - `p/7` and `p/8` carry different run keys (`hidden-101` vs `hidden-201`), so
 *   nothing in the first case can be attributed to per-run state.
 * - `p/7` and `q/7` are the same number in different projects and their runs
 *   both start at comment 101. That pairing is the only way two runs can
 *   collide: the key is `hidden-<first comment id>` (`group-events.ts`), and
 *   under `placement = "dedicated"` each project numbers its comments from 1,
 *   so two cards of one project can never share one. `placement = "shared"`
 *   makes ids globally unique and closes the path entirely.
 *
 * Every card also carries a visible comment: it is how a case knows the
 * timeline it is looking at has committed rather than still being the skeleton,
 * which holds no placeholder on either the fixed or the broken path.
 */
const CARDS = [
  { slug: "p", number: 7, hidden: [101, 102] },
  { slug: "p", number: 8, hidden: [201, 202] },
  { slug: "q", number: 7, hidden: [101, 102] },
];

const card = (slug: string, number: number) => {
  const found = CARDS.find((c) => c.slug === slug && c.number === number);
  if (!found) throw new Error(`no fixture for ${slug}/${number}`);
  return found;
};

/** Bodies carry the card's own name, so one left over from the previous card is legible as one. */
const visibleBody = (slug: string, number: number) =>
  `${slug}${number} visible`;
const hiddenBody = (slug: string, number: number, id: number) =>
  `${slug}${number} hidden ${id}`;

const itemsFor = (slug: string, number: number): TimelineItem[] => [
  ...card(slug, number).hidden.map((id) =>
    comment(id, hiddenBody(slug, number, id), true),
  ),
  comment(1, visibleBody(slug, number)),
];

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

/**
 * Every reply the page and its column ask for on their way to rendering, keyed
 * by card rather than by URL tail: case 2 changes the project and keeps the
 * number, so the slug has to be read too.
 */
function stubPage(): void {
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/me")) return json(user);
    if (url.endsWith("/api/projects")) {
      return json(
        CARDS.map(({ slug }, i) => ({ id: i + 1, slug, name: slug })),
      );
    }
    const timeline = /\/projects\/([^/]+)\/issues\/(\d+)\/timeline/.exec(url);
    if (timeline) {
      const items = itemsFor(timeline[1] as string, Number(timeline[2]));
      return json({
        items,
        prev_cursor: null,
        next_cursor: "c1",
        total_count: items.length,
      } satisfies TimelinePage);
    }
    const cardUrl = /\/projects\/([^/]+)\/issues\/(\d+)$/.exec(url);
    if (cardUrl) return json(issue(Number(cardUrl[2])));
    if (url.includes("/attachments")) return json([]);
    if (url.includes("/metadata")) return json({ namespaces: {} });
    if (url.includes("/prefs")) return json({});
    if (url.includes("/references/config")) {
      return json({ format: { prefix: "T", history: [] }, autolinks: [] });
    }
    if (url.includes("/reference-directory")) {
      return json({ entries: [], contested: [], slug_entries: [] });
    }
    // Before the project match below, which `/projects/p/issues/7/read` would
    // otherwise be answered by.
    if (url.endsWith("/read")) return json(null);
    if (url.endsWith("/labels") || url.endsWith("/statuses")) return json([]);
    if (url.endsWith("/members")) {
      return json([
        { user, role: "writer", created_at: "2026-01-01T00:00:00Z" },
      ]);
    }
    if (url.includes("/projects/p")) {
      return json({ id: 1, slug: "p", name: "p", viewer_role: "writer" });
    }
    if (url.includes("/projects/q")) {
      return json({ id: 2, slug: "q", name: "q", viewer_role: "writer" });
    }
    return json([]);
  }) as unknown as typeof fetch);
}

/**
 * What a case needs of the mounted page: the DOM to query, and a way to move it
 * the way an in-app link does. Spelled out rather than derived from `render`'s
 * and `createRouter`'s return types, so the helpers below name a contract
 * instead of an implementation.
 */
type CardView = {
  container: HTMLElement;
  goTo: (slug: string, number: number, hash?: string) => Promise<void>;
};

/** The real layout and error boundaries over the real page. */
function renderAt(url: string): CardView {
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
  const { container } = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return {
    container,
    goTo: async (slug, number, hash) => {
      await router.navigate({
        to: "/projects/$slug/issues/$number",
        params: { slug, number: String(number) },
        ...(hash === undefined ? {} : { hash }),
      });
    },
  };
}

/**
 * `unstubAllGlobals` covers `vi.stubGlobal` only; the `scrollIntoView` spy is
 * not the config's to restore, and a case added below one that installs it
 * would otherwise inherit it.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Navigate the way an in-app link does, and wait for the card to be on screen. */
async function goToCard(view: CardView, slug: string, number: number) {
  await view.goTo(slug, number);
  await waitFor(() => expect(marker(view, slug, number)).toBeTruthy());
}

const marker = (view: CardView, slug: string, number: number) =>
  within(view.container).getByText(visibleBody(slug, number));

const body = (view: CardView, text: string) =>
  within(view.container).queryByText(text);

const blocks = (view: CardView) =>
  view.container.querySelectorAll("[data-testid='hidden-block']");

/** The section rule's own entry, which is the one the page-wide flag feeds. */
async function clickRevealAll(view: CardView) {
  const divider = await waitFor(() => {
    const el = view.container.querySelector("[data-testid='timeline-divider']");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  fireEvent.click(within(divider).getByRole("button", { name: "Reveal all" }));
}

/** The placeholder's own entry, which is the one a run key feeds. */
async function clickRunReveal(view: CardView) {
  const block = await waitFor(() => {
    const found = blocks(view);
    expect(found).toHaveLength(1);
    return found[0] as HTMLElement;
  });
  fireEvent.click(within(block).getByRole("button", { name: "Reveal" }));
}

describe("a revealed run and the card it belongs to", () => {
  /**
   * Regression: the page-wide flag is the wider of the two leaks — it needs no
   * key to collide, only a reader who pressed the section rule once.
   */
  it("does not carry 'Reveal all' across to the next card", async () => {
    stubPage();
    const view = renderAt("/projects/p/issues/7");
    await waitFor(() => expect(marker(view, "p", 7)).toBeTruthy());
    // Stand on 8 first: a cold arrival renders the skeleton, which holds no
    // placeholder on either path and would make the assertion below vacuous.
    await goToCard(view, "p", 8);
    await goToCard(view, "p", 7);

    await clickRevealAll(view);
    await waitFor(() =>
      expect(body(view, hiddenBody("p", 7, 101))).toBeTruthy(),
    );

    await goToCard(view, "p", 8);

    // One assertion, not two: the marker rules out the skeleton, and the
    // placeholder is the thing the leak removes.
    await waitFor(() => {
      expect(marker(view, "p", 8)).toBeTruthy();
      expect(blocks(view)).toHaveLength(1);
    });
    expect(body(view, hiddenBody("p", 8, 201))).toBeNull();
  });

  /** Regression: the per-run half, reachable only across projects. */
  it("does not open a same-keyed run in another project", async () => {
    stubPage();
    const view = renderAt("/projects/p/issues/7");
    await waitFor(() => expect(marker(view, "p", 7)).toBeTruthy());
    await goToCard(view, "q", 7);
    await goToCard(view, "p", 7);

    await clickRunReveal(view);
    await waitFor(() =>
      expect(body(view, hiddenBody("p", 7, 101))).toBeTruthy(),
    );

    await goToCard(view, "q", 7);

    await waitFor(() => {
      expect(marker(view, "q", 7)).toBeTruthy();
      expect(blocks(view)).toHaveLength(1);
    });
    expect(body(view, hiddenBody("q", 7, 101))).toBeNull();
  });

  /**
   * Regression, and the decision this design writes down: resetting per card
   * means a reader who comes back finds the gaps closed again, which is what a
   * reload does. Remembering per card would invert both assertions here.
   */
  it("folds the run again when the reader comes back to the card", async () => {
    stubPage();
    const view = renderAt("/projects/p/issues/7");
    await waitFor(() => expect(marker(view, "p", 7)).toBeTruthy());
    await goToCard(view, "p", 8);
    await goToCard(view, "p", 7);

    await clickRunReveal(view);
    await waitFor(() =>
      expect(body(view, hiddenBody("p", 7, 101))).toBeTruthy(),
    );

    await goToCard(view, "p", 8);
    await goToCard(view, "p", 7);

    await waitFor(() => expect(blocks(view)).toHaveLength(1));
    expect(body(view, hiddenBody("p", 7, 101))).toBeNull();
  });

  /**
   * Regression against one specific mis-wiring: a card built from the location
   * rather than from the route params folds a run shut every time the reader
   * follows a permalink on the card they are already standing on.
   *
   * The anchor lands outside the run on purpose. `use-timeline-anchor.ts` has no
   * dependency array and re-decides on every render, so an anchor inside the run
   * would call `revealRun` again after the reset and leave the run open anyway —
   * the case would pass on the broken wiring and guard nothing.
   */
  it("keeps a run the reader opened open when only the hash changes", async () => {
    stubPage();
    const landed: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
      this: Element,
    ) {
      landed.push(this.id);
    });
    const view = renderAt("/projects/p/issues/7");
    await waitFor(() => expect(marker(view, "p", 7)).toBeTruthy());

    await clickRunReveal(view);
    await waitFor(() =>
      expect(body(view, hiddenBody("p", 7, 101))).toBeTruthy(),
    );

    await view.goTo("p", 7, "comment-1");

    // The anchor for the visible comment is the only thing that render does, so
    // landing on it is the proof the hash change has been rendered at all.
    await waitFor(() => expect(landed).toContain("comment-1"));
    expect(blocks(view)).toHaveLength(0);
    expect(body(view, hiddenBody("p", 7, 101))).toBeTruthy();
  });
});
