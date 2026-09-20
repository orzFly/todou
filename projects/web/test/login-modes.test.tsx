import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, runtime } from "../src/api/queries.ts";
import {
  LoginPage,
  oidcErrorText,
  oidcLoginUrl,
  safeRedirect,
} from "../src/pages/login.tsx";
import { deferred } from "./deferred.ts";
import { testQueryClient } from "./render.tsx";

const me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: true,
  created_at: "2026-01-01T00:00:00Z",
};

/** LoginPage reads its own search params, so the shim mounts it at /login. */
function renderLogin(client: QueryClient, url: string) {
  const rootRoute = createRootRoute();
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: LoginPage,
    validateSearch: (s) => s,
  });
  const projectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects",
    component: () => <div>projects-page</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, projectsRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function clientWithMode(mode: "single" | "oidc" | "forward"): QueryClient {
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode });
  return client;
}

// One stub for the whole file: happy-dom would otherwise try to navigate.
const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});

beforeEach(() => {
  vi.spyOn(runtime, "authTransition").mockImplementation((action) => action());
  vi.spyOn(runtime, "bootstrap").mockResolvedValue(me);
  vi.spyOn(runtime, "authRedirect").mockImplementation((url) => {
    window.location.assign(url);
    return deferred<never>().promise;
  });
});

afterEach(() => {
  assign.mockClear();
  vi.mocked(runtime.authTransition).mockRestore();
  vi.mocked(runtime.bootstrap).mockRestore();
  vi.mocked(runtime.authRedirect).mockRestore();
});

describe("safeRedirect", () => {
  it("accepts only same-site paths", () => {
    expect(safeRedirect("/cli-auth?port=1")).toBe("/cli-auth?port=1");
    expect(safeRedirect("//evil.example")).toBeUndefined();
    expect(safeRedirect("https://evil.example")).toBeUndefined();
    expect(safeRedirect(undefined)).toBeUndefined();
  });
});

describe("oidc helpers", () => {
  it("builds the API login URL with the resume path", () => {
    expect(oidcLoginUrl("/projects/todou")).toBe(
      `${window.location.origin}/api/auth/login?redirect=${encodeURIComponent(
        "/projects/todou",
      )}`,
    );
    expect(oidcLoginUrl(undefined)).toBe(
      `${window.location.origin}/api/auth/login`,
    );
  });

  it("has a message for every callback error code and a fallback", () => {
    for (const code of [
      "state_mismatch",
      "exchange_failed",
      "claim_missing",
      "provision_denied",
      "never-heard-of-it",
    ]) {
      expect(oidcErrorText(code)).toBeTruthy();
    }
  });
});

describe("LoginPage per auth mode", () => {
  it("single: exchanges nothing for a session and moves on", async () => {
    const login = vi.spyOn(api, "login").mockResolvedValue({
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human",
      avatar_url: null,
      owner: null,
      email: null,
      is_instance_admin: true,
      created_at: "2026-01-01T00:00:00Z",
    });
    const view = renderLogin(clientWithMode("single"), "/login");
    await view.findByText("projects-page");
    expect(login).toHaveBeenCalledTimes(1);
    login.mockRestore();
  });

  it("oidc: navigates to the API login URL exactly once", async () => {
    renderLogin(clientWithMode("oidc"), "/login?redirect=/cli-auth");
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/login?redirect=%2Fcli-auth"),
    );
  });

  it("oidc: renders a callback error with retry instead of looping", async () => {
    const view = renderLogin(
      clientWithMode("oidc"),
      "/login?error=claim_missing",
    );
    await view.findByText(oidcErrorText("claim_missing"));
    expect(assign).not.toHaveBeenCalled();
    expect(view.getByText("Try again")).toBeTruthy();
  });

  it("oidc: provision_denied shows the asserted subject for the admin", async () => {
    const view = renderLogin(
      clientWithMode("oidc"),
      "/login?error=provision_denied&subject=idp-sub-42",
    );
    await view.findByText(oidcErrorText("provision_denied"));
    expect(view.getByText("idp-sub-42")).toBeTruthy();
    expect(view.getByText(/send it to your administrator/)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("forward: reaching the page at all reads as a proxy problem", async () => {
    const view = renderLogin(clientWithMode("forward"), "/login");
    await view.findByText(/identity header/);
    expect(assign).not.toHaveBeenCalled();
    expect(runtime.authTransition).not.toHaveBeenCalled();
    expect(runtime.authRedirect).not.toHaveBeenCalled();
  });

  it("single: waits for the auth fence before HTTP and online identity before navigation", async () => {
    const fence = deferred<void>();
    vi.mocked(runtime.authTransition).mockImplementation(async (action) => {
      await fence.promise;
      return action();
    });
    const identity = deferred<typeof me>();
    vi.mocked(runtime.bootstrap).mockReturnValue(identity.promise);
    const login = vi.spyOn(api, "login").mockResolvedValue(me);
    const client = clientWithMode("single");
    const view = renderLogin(client, "/login");

    await waitFor(() => expect(runtime.authTransition).toHaveBeenCalledOnce());
    expect(login).not.toHaveBeenCalled();
    expect(client.getQueryData(["me"])).toBeUndefined();

    fence.resolve();
    await waitFor(() => expect(runtime.bootstrap).toHaveBeenCalledOnce());
    expect(login).toHaveBeenCalledOnce();
    expect(client.getQueryData(["me"])).toBeUndefined();
    expect(view.queryByText("projects-page")).toBeNull();

    const verified = { ...me, id: 2, login: "newcomer" };
    identity.resolve(verified);
    await view.findByText("projects-page");
    expect(client.getQueryData(["me"])).toEqual(verified);
    login.mockRestore();
  });

  it("single: failed identity confirmation does not seed the login response", async () => {
    const login = vi.spyOn(api, "login").mockResolvedValue(me);
    vi.mocked(runtime.bootstrap).mockRejectedValue(
      new Error("server unreachable"),
    );
    const client = clientWithMode("single");
    const view = renderLogin(client, "/login");
    await view.findByText("Could not sign in: server unreachable");
    expect(client.getQueryData(["me"])).toBeUndefined();
    expect(view.queryByText("projects-page")).toBeNull();
    login.mockRestore();
  });

  it("oidc: callback retry uses the auth fence before redirecting", async () => {
    const view = renderLogin(
      clientWithMode("oidc"),
      "/login?error=claim_missing",
    );
    await view.findByText(oidcErrorText("claim_missing"));
    expect(runtime.authRedirect).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(runtime.authRedirect).toHaveBeenCalledWith(
        oidcLoginUrl(undefined),
      ),
    );
    expect(runtime.authTransition).not.toHaveBeenCalled();
  });
});

describe("LoginPage when the mode query itself fails (T-376)", () => {
  it("offers the unified Retry control and re-issues the read", async () => {
    const mode = vi
      .spyOn(api, "authMode")
      .mockRejectedValueOnce(new Error("server unreachable"));
    const view = renderLogin(testQueryClient(), "/login");

    expect(await view.findByText(/Could not reach the server/)).toBeTruthy();
    mode.mockResolvedValueOnce({ mode: "forward" });
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mode).toHaveBeenCalledTimes(2));
    await view.findByText(/identity header/);
  });
});
