import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
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
