import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import type { Me, ReferenceConfig, Status } from "@todou/shared";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { boardColumnQuery } from "../src/api/board.ts";
import { statusesQuery } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { PageSkeleton } from "../src/components/page-skeleton.tsx";
import { AppShell } from "../src/components/shell.tsx";
import { BoardPage } from "../src/pages/board.tsx";
import { testQueryClient } from "./render.tsx";

/**
 * happy-dom performs no layout, so nothing here can see a scrollbar. What it
 * can hold is the structural rule the fix rests on: inside `<main>` the board
 * takes its size from its parent, never from the viewport. A viewport unit
 * does not subtract the scrollbar the other axis is spending, which is how two
 * page-level scrollbars used to keep each other alive.
 */
const VIEWPORT_UNIT = /\b\d+(?:\.\d+)?[dsl]?v(?:w|h|i|b|min|max)\b/;

function viewportSized(root: HTMLElement): string[] {
  const hits: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (!(el instanceof HTMLElement)) continue;
    // dnd-kit's screen-reader announcer and its drag overlay are both fixed
    // boxes: out of flow, so neither can lengthen the page, and the announcer
    // carries a constant `height: 1px` that would read as a measurement here.
    if (el.style.position === "fixed") continue;
    if (VIEWPORT_UNIT.test(el.className)) hits.push(el.className);
    if (el.style.height !== "") hits.push(`style.height=${el.style.height}`);
  }
  return hits;
}

const BOARD_STATUSES: Status[] = [
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

function boardTree() {
  const client = testQueryClient();
  client.setQueryData(statusesQuery("p").queryKey, BOARD_STATUSES);
  for (const status of BOARD_STATUSES) {
    client.setQueryData(boardColumnQuery("p", status.id).queryKey, {
      items: [],
      next_cursor: null,
    });
  }
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
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("the board takes its size from its parent", () => {
  it("draws no viewport-sized element in the skeleton", async () => {
    const view = render(<PageSkeleton kind="board" />);
    await screen.findByTestId("page-skeleton");
    expect(viewportSized(view.container)).toEqual([]);
  });

  it("draws no viewport-sized element in the board itself", async () => {
    const view = boardTree();
    await screen.findByTestId("column-Todo");
    expect(viewportSized(view.container)).toEqual([]);
  });
});

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

/**
 * These pin the classes down and nothing more: that they produce a page which
 * does not scroll was read in a real browser, and neither check stands in for
 * the other.
 */
describe("the shell's box follows the route", () => {
  function renderShell(fillsViewport: boolean) {
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
    const pageRoute = createRoute({
      getParentRoute: () => authedRoute,
      path: "/",
      staticData: fillsViewport ? { fillsViewport: true } : {},
      component: () => <div>page</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([authedRoute.addChildren([pageRoute])]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    return render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it("hands a filling route the leftover height and the full width", async () => {
    const view = renderShell(true);
    await screen.findByText("page");
    const main = view.container.querySelector("main") as HTMLElement;
    expect(main.className).toContain("flex-1");
    expect(main.className).not.toContain("max-w-6xl");
  });

  it("keeps every other route in the centred column", async () => {
    const view = renderShell(false);
    await screen.findByText("page");
    const main = view.container.querySelector("main") as HTMLElement;
    expect(main.className).toContain("max-w-6xl");
  });
});
