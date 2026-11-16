import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  MemberRole,
  Project,
  ReferenceConfig,
  Status,
} from "@todou/shared";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardColumnQuery } from "../src/api/board.ts";
import { api, statusesQuery } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { BoardPage } from "../src/pages/board.tsx";
import { testQueryClient } from "./render.tsx";

// Every render of a card's content asks for the project's ref prefix exactly
// once, and nothing else on a bare board does, so the call count is the number
// of card renders.
const prefixCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/api/references.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/api/references.ts")>();
  return {
    ...actual,
    useRefPrefix: (slug: string | undefined) => {
      prefixCalls.count++;
      return actual.useRefPrefix(slug);
    },
  };
});

afterEach(() => vi.restoreAllMocks());

const status = (id: number, name: string): Status => ({
  id,
  name,
  category: "open",
  color: "#000000",
  position: id,
  is_default: false,
});

const card = (number: number, s: Status): IssueListItem => ({
  id: number * 10,
  number,
  title: `issue ${number}`,
  status: s,
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
});

function renderBoard({ role }: { role?: MemberRole } = {}) {
  const todo = status(1, "Todo");
  const done = status(2, "Done");
  const client = testQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, staleTime: Infinity },
    mutations: { retry: false },
  });
  client.setQueryData(statusesQuery("p").queryKey, [todo, done]);
  if (role) {
    client.setQueryData(["project", "p"], {
      id: 1,
      slug: "p",
      name: "P",
      description: "",
      created_at: "2026-01-01T00:00:00Z",
      viewer_role: role,
    } satisfies Project);
    client.setQueryData(["labels", "p"], []);
    client.setQueryData(["members", "p"], []);
  }
  client.setQueryData(boardColumnQuery("p", todo.id).queryKey, {
    items: [1, 2, 3, 4].map((n) => card(n, todo)),
    next_cursor: null,
  });
  client.setQueryData(boardColumnQuery("p", done.id).queryKey, {
    items: [5, 6, 7, 8].map((n) => card(n, done)),
    next_cursor: null,
  });
  client.setQueryData(referenceConfigQuery("p").queryKey, {
    format: { prefix: "P", history: [] },
    autolinks: [],
  } satisfies ReferenceConfig);
  vi.spyOn(api, "getMutes").mockResolvedValue({ issues: [], projects: [] });

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
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([boardRoute, issueRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/projects/p/board"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const pointer = {
  pointerId: 1,
  pointerType: "mouse",
  isPrimary: true,
  button: 0,
  buttons: 1,
  clientX: 10,
  clientY: 10,
};

describe("board drag re-renders (T-691)", () => {
  it("draws the picked-up card once, in the overlay, and leaves the board alone", async () => {
    const view = renderBoard();
    const title = await view.findByRole("link", { name: /issue 1$/ });
    // Let the columns' follow-up renders (overlay scrollbars, watchers) land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    prefixCalls.count = 0;
    fireEvent.pointerDown(title, pointer);
    fireEvent.pointerMove(document, { ...pointer, clientX: 30 });
    await waitFor(() => {
      expect(view.getAllByRole("link", { name: /issue 1$/ })).toHaveLength(2);
    });
    // Eight cards on the board: before T-691 each of them re-rendered at
    // least twice here, once for dnd-kit's context and once for the page's
    // own state.
    expect(prefixCalls.count).toBeLessThanOrEqual(2);

    prefixCalls.count = 0;
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => {
      expect(view.getAllByRole("link", { name: /issue 1$/ })).toHaveLength(1);
    });
    expect(prefixCalls.count).toBe(0);
  });

  it("carries a selection without re-drawing the cards it carries (T-708)", async () => {
    const view = renderBoard({ role: "writer" });
    const title = await view.findByRole("link", { name: /issue 1$/ });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    fireEvent.click(view.getByLabelText("select P-1"));
    fireEvent.click(view.getByLabelText("select P-6"));

    prefixCalls.count = 0;
    fireEvent.pointerDown(title, pointer);
    fireEvent.pointerMove(document, { ...pointer, clientX: 30 });
    await waitFor(() => {
      expect(view.getByTestId("drag-count").textContent).toBe("2");
    });
    // The overlay's copy, and nothing else: the carried card fades in its
    // draggable shell, which dnd-kit re-renders anyway.
    expect(prefixCalls.count).toBeLessThanOrEqual(2);
    expect(
      view
        .getByLabelText("select P-6")
        .closest("[data-return-id]")
        ?.className.includes("opacity-30"),
    ).toBe(true);

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() => {
      expect(view.queryByTestId("drag-count")).toBeNull();
    });
  });
});
