import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Me, Project } from "@todou/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  projectsQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { router } from "../src/router.tsx";
import {
  restoreAppRouterPage,
  startAtDraftPage,
  teardownAppRouter,
} from "./app-router.tsx";
import { testQueryClient } from "./render.tsx";

// Same fixture shape as unsaved-guard.test.tsx.
const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const project: Project = {
  id: 1,
  slug: "p",
  name: "p",
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  viewer_role: "admin",
};

/** The mount plus the client, which the query injections below need. */
interface DraftPage {
  client: QueryClient;
  container: HTMLElement;
}

/**
 * Mounts the app's own router on the real route tree at the new-issue page —
 * the draft surface this card is about. Everything the page, the shell and
 * `ProjectLayout` read is seeded fresh, so the only failure under test is the
 * one the test injects.
 */
async function mountDraftPage(): Promise<DraftPage> {
  const client = testQueryClient();
  client.setQueryData(meQuery.queryKey, me);
  client.setQueryData(projectsQuery.queryKey, [project]);
  client.setQueryData(projectQuery("p").queryKey, project);
  client.setQueryData(statusesQuery("p").queryKey, []);
  client.setQueryData(labelsQuery("p").queryKey, []);
  client.setQueryData(membersQuery("p").queryKey, []);
  // Before the render: RouterProvider reads the history's current entry on
  // mount, so this is what decides which route the tree mounts.
  await startAtDraftPage();
  const mounted = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, container: mounted.container };
}

/** Types into the new-issue title box — the page's registered dirty source. */
async function typeDraftTitle(text: string) {
  const title = await screen.findByLabelText("Title");
  fireEvent.change(title, { target: { value: text } });
}

/**
 * Fails one query the way a real outage does: a rejected refetch over a cache
 * that still holds the last good answer. `refetchQueries` is what a window
 * focus triggers on a stale 60s query.
 */
async function refetchFail(client: QueryClient, queryKey: readonly unknown[]) {
  await act(async () => {
    await client.refetchQueries({ queryKey }).catch(() => undefined);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function failingSpy(method: "me" | "getProject", status: number) {
  return vi
    .spyOn(api, method)
    .mockRejectedValue(Object.assign(new Error(`HTTP ${status}`), { status }));
}

const beforeUnload = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

/** The draft is still mounted, with its text, and the guard still answers. */
function expectDraftIntact(text: string) {
  const title = screen.getByLabelText("Title") as HTMLInputElement;
  expect(title.value).toBe(text);
  expect(beforeUnload()).toBe(true);
}

afterEach(async () => {
  vi.restoreAllMocks();
  // Testing-library's own cleanup has run by now (globals-registered first),
  // so no guard is mounted to refuse the URL `replace`.
  restoreAppRouterPage();
  // The router is a module singleton. A test that crashed its tree (root
  // error boundary) or drove a match into the error state leaves that state
  // in the router's stores and match cache; the next test's mount then
  // renders from the leftover instead of its own URL. Drop the cache and
  // settle one load on the restored URL, so the next test mounts from a
  // fully-resolved, error-free router.
  router.clearCache();
  await router.load();
});

afterAll(teardownAppRouter);

describe("/api/me failing while a draft is on screen", () => {
  it("keeps the draft and the guard through a warm-state refetch failure", async () => {
    const view = await mountDraftPage();
    await typeDraftTitle("half a thought");

    failingSpy("me", 502);
    await refetchFail(view.client, meQuery.queryKey);

    // The draft surface is the same DOM node: no subtree was swapped, and
    // before the fix AuthedLayout replaced the shell (this input with it)
    // with its error branch.
    expectDraftIntact("half a thought");
    // The warm state's whole point is telling the user: banner up, naming
    // the failure and offering the manual retry.
    expect(
      await screen.findByText(/Couldn't reach the todou server/),
    ).toBeTruthy();
    expect(screen.getByText("Retry now")).toBeTruthy();
  });

  it("keeps the draft when ProjectLayout's query refetch-fails", async () => {
    const view = await mountDraftPage();
    await typeDraftTitle("half a thought");

    failingSpy("getProject", 502);
    await refetchFail(view.client, projectQuery("p").queryKey);

    // Before the fix the custom throwOnError throws on the failed refetch,
    // ProjectRouteError rethrows the non-404 to the router root, and the
    // whole shell — this input included — is replaced.
    expectDraftIntact("half a thought");
  });

  it("keeps the page and opens the session dialog on 401 with a draft", async () => {
    const view = await mountDraftPage();
    await typeDraftTitle("half a thought");

    failingSpy("me", 401);
    await refetchFail(view.client, meQuery.queryKey);

    // No redirect happened: the draft is still here, and the dialog explains
    // the session instead of destroying the work.
    expectDraftIntact("half a thought");
    expect(router.state.location.pathname).not.toBe("/login");
    expect(await screen.findByText("Your session has ended")).toBeTruthy();
  });

  it("does not re-open the dialog on a second 401 after staying", async () => {
    const view = await mountDraftPage();
    await typeDraftTitle("half a thought");

    failingSpy("me", 401);
    await refetchFail(view.client, meQuery.queryKey);
    const dialog = await screen.findByRole("dialog");

    // Stay on the page, then let the window focus refetch fail again — the
    // same dead session, not a new one.
    const stay = [...dialog.querySelectorAll("button")].find((button) =>
      /stay|keep|本页/i.test(button.textContent ?? ""),
    );
    expect(stay).toBeDefined();
    fireEvent.click(stay as HTMLButtonElement);
    failingSpy("me", 401);
    await refetchFail(view.client, meQuery.queryKey);

    expect(screen.queryByRole("dialog")).toBeNull();
    expectDraftIntact("half a thought");
  });

  it("after staying, a recovered session re-arms the dialog for a later loss", async () => {
    const view = await mountDraftPage();
    await typeDraftTitle("half a thought");

    failingSpy("me", 401);
    await refetchFail(view.client, meQuery.queryKey);
    const dialog = await screen.findByRole("dialog");

    // Stay on the page. This is the path where the reset earns its keep:
    // `announced` is now true, and only a successful refetch clears it.
    const stay = [...dialog.querySelectorAll("button")].find((button) =>
      /stay|keep|本页/i.test(button.textContent ?? ""),
    );
    expect(stay).toBeDefined();
    fireEvent.click(stay as HTMLButtonElement);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Session returns: page back to normal, no dialog (it was dismissed, not
    // dissolved — the recovery reset is what allows the next announcement).
    vi.spyOn(api, "me").mockResolvedValue(me);
    await refetchFail(view.client, meQuery.queryKey);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectDraftIntact("half a thought");

    // A later 401 announces itself again — fails if the reset is gone.
    failingSpy("me", 401);
    await refetchFail(view.client, meQuery.queryKey);
    expect(await screen.findByText("Your session has ended")).toBeTruthy();
    expectDraftIntact("half a thought");
  });

  it("dissolves the dialog on its own when the session returns untouched", async () => {
    const view = await mountDraftPage();
    await typeDraftTitle("half a thought");

    failingSpy("me", 401);
    await refetchFail(view.client, meQuery.queryKey);
    // Dialog is up and stays up while the session stays dead — no click, no
    // dismiss. (Guards against a dialog that closes by itself, which a
    // click-then-assert sequence would never notice.)
    await screen.findByText("Your session has ended");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // The session returns (re-login in another tab): the dialog dissolves on
    // its own, with no user action.
    vi.spyOn(api, "me").mockResolvedValue(me);
    await refetchFail(view.client, meQuery.queryKey);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectDraftIntact("half a thought");
  });

  it("shows the in-shell error panel on a cold-start failure", async () => {
    // No `me` seeded: the app boots straight into the failure. Same draft URL
    // as the rest of the suite — cold start has no draft to lose, but the
    // answer must hold where the other states do.
    const client = testQueryClient();
    client.setQueryData(projectsQuery.queryKey, [project]);
    client.setQueryData(projectQuery("p").queryKey, project);
    client.setQueryData(statusesQuery("p").queryKey, []);
    client.setQueryData(labelsQuery("p").queryKey, []);
    client.setQueryData(membersQuery("p").queryKey, []);
    vi.spyOn(api, "me").mockRejectedValue(
      Object.assign(new Error("HTTP 502"), { status: 502 }),
    );
    await startAtDraftPage();
    const mounted = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // The failure is what routes here, so assert on its text arriving; the
    // failure panel lives inside the shell's `<main>`, not in place of the
    // shell, and the account slot says so instead of spinning a skeleton.
    await screen.findByText("Account unavailable");
    const header = mounted.container.querySelector("header");
    expect(header).not.toBeNull();
    expect(header?.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("still redirects to /login on 401 with nothing unsaved", async () => {
    const view = await mountDraftPage();
    // The title is never touched: no dirty source registers.

    failingSpy("me", 401);
    await act(async () => {
      await view.client
        .refetchQueries({ queryKey: meQuery.queryKey })
        .catch(() => undefined);
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toMatchObject({
      redirect: expect.anything(),
    });
  });
});
