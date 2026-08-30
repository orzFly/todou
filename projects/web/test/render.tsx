import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

// happy-dom ships no EventSource, and the shell opens the user-level stream
// on mount (T-122). An inert stand-in keeps shell-rendering tests mountable;
// real stream behavior is covered in user-events.test.tsx with its own mock.
class InertEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = InertEventSource.CONNECTING;
  onerror: unknown = null;
  onopen: unknown = null;
  addEventListener() {}
  close() {}
}
if (typeof globalThis.EventSource === "undefined") {
  (globalThis as { EventSource?: unknown }).EventSource = InertEventSource;
}

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * Mount a component that needs router context (Link, useRouterState)
 * without the app router: a shim tree whose index route renders `ui`,
 * plus the issue-detail path so issue/comment links resolve. Memory
 * history keeps one test's navigation from leaking into the next.
 * RouterProvider mounts asynchronously — assert via waitFor/findBy.
 */
export function renderWithProviders(
  ui: ReactElement,
  client: QueryClient = testQueryClient(),
) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const specRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number/spec",
  });
  const searchRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "search",
    validateSearch: (search: Record<string, unknown>) => search,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectRoute.addChildren([issueRoute, specRoute, searchRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
