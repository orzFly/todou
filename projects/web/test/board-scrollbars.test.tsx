import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import type { IssueListItem, ReferenceConfig, Status } from "@todou/shared";
import { OverlayScrollbars } from "overlayscrollbars";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { boardColumnQuery } from "../src/api/board.ts";
import { statusesQuery } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { BoardPage } from "../src/pages/board.tsx";
import { testQueryClient } from "./render.tsx";

/**
 * happy-dom performs no layout, so what a scrollbar looks like and what it
 * covers were read in a browser. What survives here is the wiring the look
 * rests on: which element the cards hang off, which element the bars hang
 * off, and that leaving the board takes the instances with it.
 */

const STATUSES: Status[] = [
  {
    id: 1,
    name: "Todo",
    color: "#123456",
    category: "open",
    position: 1,
    is_default: true,
  },
  {
    id: 2,
    name: "Next",
    color: "#a855f7",
    category: "open",
    position: 2,
    is_default: false,
  },
];

const card = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: STATUSES[1],
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
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
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
});

function boardTree(): { container: HTMLElement; client: QueryClient } {
  const client = testQueryClient();
  client.setQueryData(statusesQuery("p").queryKey, STATUSES);
  client.setQueryData(boardColumnQuery("p", 1).queryKey, {
    items: [],
    next_cursor: null,
  });
  client.setQueryData(boardColumnQuery("p", 2).queryKey, {
    items: [card(7, "first"), card(8, "second")],
    next_cursor: null,
  });
  client.setQueryData(referenceConfigQuery("p").queryKey, {
    format: { prefix: "T", history: [] },
    autolinks: [],
  } satisfies ReferenceConfig);

  // BoardPage reads its params strictly from "/authed/projects/$slug", so the
  // shim tree needs that same pathless "authed" id.
  const rootRoute = createRootRoute();
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
    history: createMemoryHistory({ initialEntries: ["/projects/p/board"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { container: view.container, client };
}

/** The scroll container of the column a status name identifies. */
function viewportOf(container: HTMLElement, statusName: string): HTMLElement {
  const column = container.querySelector(
    `[data-testid="column-${statusName}"]`,
  );
  const viewport = column?.querySelector(".overflow-y-auto");
  if (!(viewport instanceof HTMLElement)) {
    throw new Error(`no scroll container in column ${statusName}`);
  }
  return viewport;
}

function directChildScrollbars(element: Element): number {
  return [...element.children].filter((child) =>
    child.classList.contains("os-scrollbar"),
  ).length;
}

describe("the board columns' overlay scrollbars", () => {
  it("leaves the cards on the container that carries the column's layout", async () => {
    const { container } = boardTree();
    await screen.findByText("first");

    const cards = container.querySelectorAll(
      '[aria-roledescription="draggable"]',
    );
    expect(cards).toHaveLength(2);
    for (const element of cards) {
      // Not a hook added for this test: `useDraggable` puts the attribute on
      // every card, and it is the card's own root that must stay a child of
      // the scroll container — a library-inserted viewport in between would
      // take `gap-2` off the cards and close the spacing to 0.
      const parent = element.parentElement as HTMLElement;
      expect(parent.className).toContain("overflow-y-auto");
      expect(parent.className).toContain("gap-2");
    }
  });

  it("draws the bars in the slot beside the scroll container, not inside it", async () => {
    const { container } = boardTree();
    await screen.findByText("first");

    const viewport = viewportOf(container, "Next");
    const slot = viewport.parentElement as HTMLElement;
    // Inside the scroll container the bars are positioned against the
    // scrolled box and slide out of view with the content.
    expect(directChildScrollbars(slot)).toBe(2);
    expect(directChildScrollbars(viewport)).toBe(0);
  });

  it("destroys a column's instance when the column goes away", async () => {
    const { container, client } = boardTree();
    await screen.findByText("first");

    const viewport = viewportOf(container, "Next");
    expect(OverlayScrollbars(viewport)).toBeDefined();

    client.setQueryData(statusesQuery("p").queryKey, [STATUSES[0]]);
    await waitFor(() => {
      expect(screen.queryByTestId("column-Next")).toBeNull();
    });

    // Detaching the element is not destroying it: the instance survives an
    // unmount that skips the effect's cleanup, which is what this asks about.
    expect(OverlayScrollbars(viewport)).toBeUndefined();
  });
});
