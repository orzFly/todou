import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/queries.ts";
import { router } from "../src/router.tsx";

const me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  owner: null,
  email: null,
  is_instance_admin: true,
  created_at: "2026-08-11T00:00:00Z",
};

/** Single-user server: /me is 401 until POST /auth/login flips the session. */
function fakeServer() {
  let loggedIn = false;
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/api/auth/mode") {
      return reply(200, { mode: "single" });
    }
    if (url.pathname === "/api/auth/login" && init?.method === "POST") {
      loggedIn = true;
      return reply(200, me);
    }
    if (url.pathname === "/api/me") {
      return loggedIn
        ? reply(200, me)
        : reply(401, {
            error: { code: "unauthorized", message: "authentication required" },
          });
    }
    if (url.pathname === "/api/projects") {
      return reply(200, []);
    }
    return reply(404, { error: { code: "not_found", message: url.pathname } });
  }) as typeof fetch;
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("fresh visitor (no session)", () => {
  // Regression: the 401 → /login redirect once re-fired <Navigate> from live
  // router state, nesting ?redirect= forever and hanging the main thread.
  it("settles on /projects through login without looping", async () => {
    vi.stubGlobal("fetch", fakeServer());
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(
      () => expect(router.state.location.pathname).toBe("/projects"),
      { timeout: 5000 },
    );
    expect(router.state.location.search).toEqual({});
  }, 10000);
});
