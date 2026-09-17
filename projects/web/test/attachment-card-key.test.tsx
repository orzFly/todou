import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type { Attachment, TimelinePage } from "@todou/shared";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueDetailPage } from "../src/pages/issue-detail.tsx";
import { IssueRouteError } from "../src/pages/issue-route-error.tsx";
import {
  ProjectLayout,
  ProjectRouteError,
} from "../src/pages/project-layout.tsx";
import { testQueryClient } from "./render.tsx";

/**
 * The key on `AttachmentList` (T-369), asserted against the real issue page.
 *
 * The fold is component state, so only a remount clears it, and the remount
 * is bought by one `key` in `issue-detail.tsx`. A case that mounts its own
 * `AttachmentList` would supply that key itself and keep passing with the
 * page's line deleted — the argument `timeline-key.test.tsx` and
 * `revealed-runs-card.test.tsx` both make, and the same route tree they use.
 *
 * That key also has to differ from the one on its sibling `Timeline`, which is
 * what the second case holds: alike, React matches neither against the other
 * and abandons this section's DOM node on the page (T-402).
 */

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

/** The card the reader lands on with nothing of its own to show. */
const cardWithoutFiles = 9;

/** Eight files, which is where folding starts. */
const filesFor = (card: number): Attachment[] =>
  Array.from({ length: 8 }, (_, i) => ({
    id: card * 100 + i + 1,
    filename: `card-${card}-file-${i + 1}.png`,
    content_type: "image/png",
    size: 512,
    url: `/api/projects/p/attachments/${card * 100 + i + 1}/download/card-${card}-file-${i + 1}.png`,
    uploader: user,
    created_at: `2026-09-0${i + 1}T00:00:00Z`,
    aliases: [],
  }));

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

const emptyPage: TimelinePage = {
  items: [],
  prev_cursor: null,
  next_cursor: null,
  total_count: 0,
};

/** Every reply the page asks for on its way to rendering the section. */
function stubPage(): void {
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/me")) return json(user);
    if (url.endsWith("/api/projects")) {
      return json([{ id: 1, slug: "p", name: "p" }]);
    }
    if (url.includes("/attachments")) {
      const card = Number(/issue_number=(\d+)/.exec(url)?.[1]);
      return json(card === cardWithoutFiles ? [] : filesFor(card));
    }
    if (url.includes("/metadata")) return json({ namespaces: {} });
    if (url.includes("/prefs")) return json({});
    if (url.includes("/references/config")) {
      return json({ format: { prefix: "T", history: [] }, autolinks: [] });
    }
    if (url.includes("/reference-directory")) {
      return json({ entries: [], contested: [], slug_entries: [] });
    }
    if (url.includes("/timeline")) return json(emptyPage);
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the issue page's attachment section, keyed by card", () => {
  it("does not carry an expanded list across to the next card", async () => {
    stubPage();
    const view = renderAt("/projects/p/issues/7");
    // Named by card, because what this case reads is whose files the reader
    // gets; how many sections the page carries is the case below.
    const sectionFor = (card: number) =>
      [...view.container.querySelectorAll("section#attachments")].find((el) =>
        el.textContent?.includes(`card-${card}-file-`),
      ) as HTMLElement | undefined;
    const rowsOn = (card: number) =>
      sectionFor(card)?.querySelectorAll("li").length;

    await waitFor(() => expect(rowsOn(7)).toBe(5));
    fireEvent.click(view.getByTestId("attachment-fold-toggle"));
    await waitFor(() => expect(rowsOn(7)).toBe(8));

    await view.router.navigate({
      to: "/projects/$slug/issues/$number",
      params: { slug: "p", number: "8" },
    });

    // Card 8 arrives folded. Unkeyed, one instance survives the param change
    // with `expanded` still true and all eight of its rows show.
    await waitFor(() => expect(sectionFor(8)).toBeTruthy());
    expect(rowsOn(8)).toBe(5);
    expect(
      within(sectionFor(8) as HTMLElement).getByTestId("attachment-fold-toggle")
        .textContent,
    ).toContain("展开其余 3 个");
  });

  it("leaves no section behind when the reader jumps on", async () => {
    stubPage();
    const view = renderAt("/projects/p/issues/7");
    const panels = () => [
      ...view.container.querySelectorAll("section#attachments"),
    ];
    const arriveAt = async (card: number) => {
      await view.router.navigate({
        to: "/projects/$slug/issues/$number",
        params: { slug: "p", number: String(card) },
      });
      await waitFor(() =>
        expect(
          within(view.container).getAllByText(`Card ${card}`).length,
        ).toBeGreaterThan(0),
      );
    };

    await waitFor(() => expect(panels()).toHaveLength(1));

    for (const card of [8, 7, 8]) {
      await arriveAt(card);
      await waitFor(() =>
        expect(
          panels().some((el) => el.textContent?.includes(`card-${card}-file-`)),
        ).toBe(true),
      );
      expect(panels()).toHaveLength(1);
    }

    // The worst arrival of the lot: nothing of this card's to list, so a
    // section left behind is the one the `#attachments` anchor and the
    // sidebar's jump both land on — somebody else's files.
    await arriveAt(cardWithoutFiles);
    expect(panels()).toHaveLength(0);
  });
});
