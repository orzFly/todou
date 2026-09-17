import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { PublicUser } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { userQuery } from "../src/api/users.ts";
import {
  UserProfilePage,
  UserRedirectPage,
} from "../src/pages/user-profile.tsx";

const alice: PublicUser = {
  id: 7,
  login: "alice",
  display_name: "Alice Potato",
  kind: "human",
  avatar_url: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
};

const bot: PublicUser = {
  id: 8,
  login: "bot-one",
  display_name: "A Bot",
  kind: "machine",
  avatar_url: null,
  owner: { id: 7, login: "alice" },
  created_at: "2026-02-01T00:00:00Z",
};

const Root = createRootRoute();

/** The app's own dispatch (router.tsx): digits redirect, names render. */
function UserRoutePage() {
  const ref = useParams({
    from: Route.fullPath as never,
    strict: false,
  }) as { ref: string };
  return /^\d{1,15}$/.test(ref.ref) ? (
    <UserRedirectPage ref={ref.ref} />
  ) : (
    <UserProfilePage ref={ref.ref} />
  );
}

const Route = createRoute({
  getParentRoute: () => Root,
  path: "/users/$ref",
  component: UserRoutePage,
});

/**
 * Render the user page at a real router address, so a test arrives the way
 * a reader does: by URL.
 */
function renderAt(path: string, client: QueryClient) {
  const router = createRouter({
    routeTree: Root.addChildren([Route]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

const clientWith = (data: PublicUser): QueryClient => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(userQuery(data.login).queryKey, data);
  return client;
};

/** Answers both spellings: the id load, then the login page it redirects to. */
const clientWithId = (data: PublicUser, id: number): QueryClient => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(userQuery(String(id)).queryKey, data);
  client.setQueryData(userQuery(data.login).queryKey, data);
  return client;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UserProfilePage (T-373)", () => {
  it("shows the identity facts by login", async () => {
    const view = renderAt("/users/alice", clientWith(alice));
    expect(await view.findByText("Alice Potato")).toBeTruthy();
    expect(view.getByText("@alice")).toBeTruthy();
    expect(view.getByText(/joined/)).toBeTruthy();
  });

  it("names the machine account and its owner", async () => {
    const view = renderAt("/users/bot-one", clientWith(bot));
    expect(await view.findByText(/agent · belongs to @alice/)).toBeTruthy();
  });

  it("shows an explanation on 404, not a blank page", async () => {
    vi.spyOn(api, "getUser").mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    const view = renderAt(
      "/users/alice",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    expect(await view.findByText("No such user here")).toBeTruthy();
    // 404 is an empty state, not a failure: there is nothing to retry into.
    // Green before this card too — a fence against "swap the whole isError
    // block for a LoadFailure", not evidence the card was fixed.
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("carries no email anywhere in the payload it renders", async () => {
    const view = renderAt("/users/alice", clientWith(alice));
    await view.findByText("Alice Potato");
    expect(view.container.textContent).not.toContain("@example");
    expect("email" in alice).toBe(false);
  });

  it("an id address redirects to the login one, replacing history", async () => {
    // The path every stored mention link actually takes: `/users/7` loads
    // by id, then hands the reader to `/users/alice` with replace.
    const view = renderAt("/users/7", clientWithId(alice, 7));
    expect(await view.findByText("Alice Potato")).toBeTruthy();
    expect(view.router.state.location.pathname).toBe("/users/alice");
    // Replace, not push: the id form never lingers in history.
    expect(view.router.history.canGoBack()).toBe(false);
  });
});

describe("UserProfilePage load failure (T-409)", () => {
  it("offers Retry on a non-404 failure, and recovers when the read succeeds", async () => {
    let failing = true;
    const getUser = vi.spyOn(api, "getUser").mockImplementation(async () => {
      if (failing) {
        throw Object.assign(new Error("server on fire"), { status: 500 });
      }
      return alice;
    });
    const view = renderAt(
      "/users/alice",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await view.findByText(/Could not load this user/);
    expect(view.queryByText("Try again in a moment.")).toBeNull();
    expect(getUser).toHaveBeenCalledTimes(1);

    failing = false;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(await view.findByText("Alice Potato")).toBeTruthy();
    // The ref each call asked for, not just the count: a retry bound to the
    // wrong query would still reach two calls.
    expect(getUser.mock.calls.map((c) => c[0])).toEqual(["alice", "alice"]);
  });

  it("retries the ref the page is actually showing", async () => {
    // What the previous case cannot catch: its ref is "alice" throughout, so
    // a retry bound to a hardcoded "alice" passes it. This one is a different
    // account, so a ref-insensitive retry refetches the wrong query and the
    // page never resolves.
    let failing = true;
    const getUser = vi.spyOn(api, "getUser").mockImplementation(async () => {
      if (failing) {
        throw Object.assign(new Error("server on fire"), { status: 503 });
      }
      return bot;
    });
    const view = renderAt(
      "/users/bot-one",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await view.findByText(/Could not load this user/);

    failing = false;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(await view.findByText("A Bot")).toBeTruthy();
    expect(getUser.mock.calls.map((c) => c[0])).toEqual(["bot-one", "bot-one"]);
  });

  it("greys the button, not the screen, when the failure kept its data", async () => {
    // The one path where `retrying` has something to describe. A refetch that
    // fails with data already cached (window refocus past the 60s staleTime,
    // server away) leaves status "error" with the data kept, so this branch
    // renders and `fetchState` does not reset it to pending on the next
    // fetch. With no cached data the panel unmounts into the skeleton
    // instead and the button never gets to render disabled.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(userQuery("alice").queryKey, alice);
    const view = renderAt("/users/alice", client);
    await view.findByText("Alice Potato");

    vi.spyOn(api, "getUser").mockRejectedValue(
      Object.assign(new Error("server on fire"), { status: 500 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: userQuery("alice").queryKey });
    });
    await view.findByText(/Could not load this user/);

    let release: (user: PublicUser) => void = () => undefined;
    vi.spyOn(api, "getUser").mockImplementation(
      () =>
        new Promise<PublicUser>((resolve) => {
          release = resolve;
        }),
    );
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(
        view.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
      ).toBe(true);
    });

    await act(async () => {
      release(alice);
    });
    expect(await view.findByText("Alice Potato")).toBeTruthy();
  });
});
