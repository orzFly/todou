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

/**
 * Boots the app with nothing seeded for `me` and `/api/me` failing, so the
 * app lands straight in the cold-start branch. Same draft URL as the rest of
 * the suite — cold start has no draft to lose, but the answer must hold where
 * the other states do. The spy comes back with the mount because half of what
 * separates this panel from a button that merely looks right is what it calls.
 */
async function mountColdStart(): Promise<{
  container: HTMLElement;
  meSpy: ReturnType<typeof failingSpy>;
}> {
  const client = testQueryClient();
  client.setQueryData(projectsQuery.queryKey, [project]);
  client.setQueryData(projectQuery("p").queryKey, project);
  client.setQueryData(statusesQuery("p").queryKey, []);
  client.setQueryData(labelsQuery("p").queryKey, []);
  client.setQueryData(membersQuery("p").queryKey, []);
  const meSpy = failingSpy("me", 502);
  await startAtDraftPage();
  const mounted = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { container: mounted.container, meSpy };
}

/**
 * Holds the next `/api/me` open until the returned `reject` is called, so a
 * test can assert on a state that lasts rather than on one a clock ends. An
 * assertion on a window something else closes would read the same whatever
 * opened it.
 */
function holdNextMeFetch(meSpy: ReturnType<typeof failingSpy>): () => void {
  let fail!: (error: unknown) => void;
  meSpy.mockImplementationOnce(
    () =>
      new Promise<Me>((_, reject) => {
        fail = reject;
      }),
  );
  return () => fail(Object.assign(new Error("HTTP 502"), { status: 502 }));
}

/** The panel's one button, held across renders so `disabled` can be read off
 * the same node the click landed on. */
async function findRetryButton(): Promise<HTMLButtonElement> {
  return (await screen.findByRole("button", {
    name: "Retry",
  })) as HTMLButtonElement;
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
    const view = await mountColdStart();

    // The failure is what routes here, so assert on its text arriving; the
    // failure panel lives inside the shell's `<main>`, not in place of the
    // shell, and the account slot says so instead of spinning a skeleton.
    await screen.findByText("Account unavailable");
    const header = view.container.querySelector("header");
    expect(header).not.toBeNull();
    expect(header?.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("refetches the account on Retry, error text still on screen", async () => {
    const view = await mountColdStart();

    // The whole sentence, error included: what T-376 did at three other
    // panels was move the raw error off the line and onto the `title` alone,
    // and only asserting the joined string notices that happening here.
    await screen.findByText("Failed to reach the todou server: HTTP 502");
    // Pinned before the click as well as after: the "before" is what makes
    // the "after" mean the click did it, and it also says nothing else on
    // this panel is fetching on its own.
    expect(view.meSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(await findRetryButton());
    await waitFor(() => expect(view.meSpy).toHaveBeenCalledTimes(2));
  });

  it("renders the shared failure shape, not a renamed hand-rolled panel", async () => {
    await mountColdStart();

    const retry = await findRetryButton();
    // The old wording is gone from the tree, so "renamed the old button" and
    // "forgot to delete it" both fail here instead of passing as an adoption.
    expect(screen.queryByText("Try again")).toBeNull();
    // The raw error rides the message line's `title`, and nothing rides the
    // button's — the part of the shared contract a hand-written pair of
    // elements never happens to have.
    expect(
      screen
        .getByText("Failed to reach the todou server: HTTP 502")
        .getAttribute("title"),
    ).toBe("HTTP 502");
    expect(retry.getAttribute("title")).toBeNull();
  });

  it("keeps the panel up through its own refetch, no skeleton swap", async () => {
    const view = await mountColdStart();

    const retry = await findRetryButton();
    expect(document.querySelectorAll("[data-slot=skeleton]")).toHaveLength(0);

    const failTheRetry = holdNextMeFetch(view.meSpy);
    fireEvent.click(retry);
    await waitFor(() => expect(view.meSpy).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // Read `me.isError` live and this is where the panel would go: with no
    // cached account, query-core resets the query to pending the instant a
    // fetch starts (query.js, `fetchState`), and the branch would hand the
    // screen to PagePending for the length of every attempt — the 15s poll's
    // as much as this click's.
    expect(retry.isConnected).toBe(true);
    expect(
      screen.getByText("Failed to reach the todou server: HTTP 502"),
    ).toBeTruthy();
    // Both halves, because "no skeletons" alone also holds for a panel that
    // rendered nothing at all.
    expect(document.querySelectorAll("[data-slot=skeleton]")).toHaveLength(0);

    failTheRetry();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(retry.isConnected).toBe(true);
  });

  it("greys Retry for the fetch the click started, and no other", async () => {
    const view = await mountColdStart();

    const retry = await findRetryButton();
    // Nothing is in flight before the gesture. This pair is the half that
    // tells a button greyed by the 15s poll — which keeps refetching this very
    // branch (router.tsx's refetchInterval) — apart from one greyed by the
    // click, and it is what makes the count after the click mean anything.
    expect(retry.disabled).toBe(false);
    expect(view.meSpy).toHaveBeenCalledTimes(1);

    const failTheRetry = holdNextMeFetch(view.meSpy);
    fireEvent.click(retry);
    await waitFor(() => expect(retry.disabled).toBe(true));
    expect(view.meSpy).toHaveBeenCalledTimes(2);

    // Held open, it stays greyed, and the count stays the click's own: the
    // greying ends when this one fetch does, not when a timer says so.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(retry.disabled).toBe(true);
    expect(view.meSpy).toHaveBeenCalledTimes(2);

    // Releasing that one fetch, and nothing else, is what gives the button
    // back.
    failTheRetry();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(retry.disabled).toBe(false);
  });

  it("drops the panel when a retry finally brings the account", async () => {
    const view = await mountColdStart();
    const retry = await findRetryButton();

    view.meSpy.mockResolvedValueOnce(me);
    fireEvent.click(retry);

    // The account arrived, so the panel goes and the app renders its page —
    // asserted positively as well, because "the panel is gone" also holds for
    // a tree that rendered nothing at all.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(),
    );
    expect(
      screen.queryByText("Failed to reach the todou server: HTTP 502"),
    ).toBeNull();
    expect(await screen.findByLabelText("Title")).toBeTruthy();
  });

  it("hands a cold start over to /login once the failure turns 401", async () => {
    const view = await mountColdStart();
    const retry = await findRetryButton();

    // The session turns out to be the problem after all. A dead session has
    // to reach /login; the latch must not hold the screen behind a panel that
    // goes on offering to retry something no retry can fix.
    view.meSpy.mockRejectedValue(
      Object.assign(new Error("HTTP 401"), { status: 401 }),
    );
    fireEvent.click(retry);

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
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
