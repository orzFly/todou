import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { PublicUser } from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { userQuery } from "../src/api/users.ts";
import { UserProfilePage } from "../src/pages/user-profile.tsx";

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

function renderWithProviders(ui: ReactElement, client: QueryClient) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const userRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/users/$ref",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, userRoute]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const clientWith = (data: PublicUser): QueryClient => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(userQuery(data.login).queryKey, data);
  return client;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UserProfilePage (T-373)", () => {
  it("shows the identity facts by login", async () => {
    const view = renderWithProviders(
      <UserProfilePage ref="alice" />,
      clientWith(alice),
    );
    expect(await view.findByText("Alice Potato")).toBeTruthy();
    expect(view.getByText("@alice")).toBeTruthy();
    expect(view.getByText(/joined/)).toBeTruthy();
  });

  it("names the machine account and its owner", async () => {
    const view = renderWithProviders(
      <UserProfilePage ref="bot-one" />,
      clientWith(bot),
    );
    expect(await view.findByText(/agent · belongs to @alice/)).toBeTruthy();
  });

  it("shows an explanation on 404, not a blank page", async () => {
    vi.spyOn(api, "getUser").mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    const view = renderWithProviders(
      <UserProfilePage ref="alice" />,
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    expect(await view.findByText("No such user here")).toBeTruthy();
  });

  it("carries no email anywhere in the payload it renders", async () => {
    const view = renderWithProviders(
      <UserProfilePage ref="alice" />,
      clientWith(alice),
    );
    await view.findByText("Alice Potato");
    expect(view.container.textContent).not.toContain("@example");
    expect("email" in alice).toBe(false);
  });
});
