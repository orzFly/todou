import { QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Me } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/shell.tsx";
import { router } from "../src/router.tsx";
import { testQueryClient } from "./render.tsx";

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
 * The first ancestor painted out of existence, or null. React does not
 * unmount the children a Suspense boundary is standing in for — it sets
 * `display: none !important` on them — so "the header vanished" is a style on
 * something above it, not a missing node.
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the shell during navigation", () => {
  /**
   * The real tree's shape: a pathless "authed" route between the root and
   * `/projects/$slug`. `ProjectLayout` and `IssueRouteError` read their params
   * strictly from `/authed/projects/$slug`, so a shim missing that id would be
   * testing a route table the app does not have.
   */
  function renderTree(gate: Promise<string>) {
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
    const listRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "/",
      component: () => (
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug: "alpha", number: "12" }}
        >
          open the card
        </Link>
      ),
    });
    const issueRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "issues/$number",
      staticData: { pageSkeleton: "detail" },
      component: function StalledIssuePage() {
        const query = useSuspenseQuery({
          queryKey: ["gate"],
          queryFn: () => gate,
        });
        return <div>{query.data}</div>;
      },
    });
    const testRouter = createRouter({
      routeTree: rootRoute.addChildren([
        authedRoute.addChildren([
          projectRoute.addChildren([listRoute, issueRoute]),
        ]),
      ]),
      history: createMemoryHistory({ initialEntries: ["/projects/alpha"] }),
    });
    return render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={testRouter} />
      </QueryClientProvider>,
    );
  }

  it("keeps the header in place while the next page's data is in flight", async () => {
    let open: (() => void) | undefined;
    const gate = new Promise<string>((resolve) => {
      open = () => resolve("the card");
    });
    const view = renderTree(gate);

    const link = await screen.findByText("open the card");
    const header = view.container.querySelector("header");
    expect(header).not.toBeNull();

    fireEvent.click(link);

    // The page under the header is the skeleton the route asked for…
    const skeleton = await screen.findByTestId("page-skeleton");
    expect(skeleton.getAttribute("data-kind")).toBe("detail");
    // …and the header is still on screen. Before T-265 the shell's own
    // container carried `display: none !important` at this point.
    expect(view.container.querySelector("header")).toBe(header);
    expect(hiddenAncestorOf(header)).toBeNull();

    open?.();

    expect(await screen.findByText("the card")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("page-skeleton")).toBeNull(),
    );
    expect(view.container.querySelector("header")).toBe(header);
    expect(hiddenAncestorOf(header)).toBeNull();
  });
});

describe("the shell on first paint", () => {
  it("renders the header before /api/me answers", async () => {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = new URL(String(input), "http://localhost");
      // Never settles: the assertions all describe the state while the
      // account is still on the wire.
      if (url.pathname === "/api/me") return new Promise<Response>(() => {});
      return new Response(JSON.stringify({ mode: "single" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    const view = render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const header = await waitFor(() => {
      const found = view.container.querySelector("header");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(hiddenAncestorOf(header)).toBeNull();

    // No account yet, so no menu to open — the slot holds a placeholder.
    expect(header.querySelector("[data-slot=skeleton]")).not.toBeNull();
    expect(screen.queryByText("User")).toBeNull();

    const main = view.container.querySelector("main");
    expect(main).not.toBeNull();
    expect(main?.querySelector("[data-testid=page-skeleton]")).not.toBeNull();
  });
});
