import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { router } from "../src/router.tsx";

/**
 * The app's own router, for the things a shim cannot reach: it is built on
 * the browser history, and only that implementation installs a `beforeunload`
 * listener (`@tanstack/history`, `onBeforeUnload` — `createMemoryHistory`
 * reads no `enableBeforeUnload`).
 *
 * The router is a module singleton and its browser history is created once at
 * import, listener included. `teardownAppRouter` is what removes that
 * listener again; doing it per test would leave every later test asserting
 * against a listener nobody installed, where `defaultPrevented === false`
 * would mean "nothing was listening" just as much as "the guard never
 * answered". Re-mounting `<RouterProvider>` does not reinstall it — the
 * router keeps the history instance it built at import.
 *
 * `restoreAppRouterPage` puts back the URL and the title the shell stamps, so
 * one test's route cannot choose where the next one mounts. It must run after
 * testing-library has unmounted the tree: a mounted guard holding unsaved
 * work would refuse the `replace` the restore needs.
 */
const originalUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
const originalTitle = document.title;

/**
 * The URL every test starts from: the card's own draft surface, where a
 * subtree swap would destroy real unsaved work. `/` only redirects to
 * `/projects`, whose list page holds no draft at all.
 *
 * The navigate promise is deliberately not awaited. The previous test's tree
 * held the history blocker while it was dirty, and after a tree-crashing test
 * the singleton router only unwedges through a real navigation — an awaited
 * navigate can then hang past any timeout. Fire it, let the router settle in
 * the background, and assert on the page itself arriving: what the test
 * cares about is the rendered tree, not the promise.
 */
export function startAtDraftPage() {
  void router
    .navigate({
      to: "/projects/$slug/issues/new",
      params: { slug: "p" },
      replace: true,
      ignoreBlocker: true,
    })
    .catch(() => undefined);
  // One tick so the navigate's history write lands before the next render.
  return new Promise((resolve) => setTimeout(resolve, 50));
}

export function renderOnTheAppRouter(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

export function restoreAppRouterPage() {
  document.title = originalTitle;
  // A `replace`, never a `push`: the history keeps no entry to step back onto.
  router.history.replace(originalUrl);
  // `replace` queues its write on a microtask. When the restore is the last
  // thing a test file does, that queue can outlive the happy-dom window, and
  // the flush then reaches happy-dom's destroyed History and throws. Flush
  // it here, while the window is guaranteed to exist.
  router.history.flush();
}

export function teardownAppRouter() {
  // The final `replace` re-queues its write on a microtask, and vitest tears
  // the happy-dom window down between the last test and that microtask —
  // the flush then reaches the destroyed History and throws. Flush
  // synchronously, then remove the `beforeunload` listener last.
  router.history.replace(originalUrl);
  router.history.flush();
  router.history.destroy();
}
