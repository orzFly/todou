import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { NewIssueButton } from "../src/components/new-issue-button.tsx";
import { recordVisit } from "../src/lib/project-visits.ts";
import { testQueryClient } from "./render.tsx";

const DAY = 86_400_000;

function project(slug: string, createdDaysAgo = 300): Project {
  return {
    id: slug.length,
    slug,
    name: slug,
    description: "",
    created_at: new Date(Date.now() - createdDaysAgo * DAY).toISOString(),
  };
}

const me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

// Distinct ages so the zero-score tail never ties: without visits the order
// is [beta, alpha] (newest creation first).
const projects = [project("alpha", 300), project("beta", 200)];

/**
 * The button needs live routes to land its navigations somewhere; the
 * subtree mirrors the app's so the in-project and off-project shapes match.
 */
function renderButton(at: string, available: Project[] = projects) {
  const c = testQueryClient();
  c.setQueryData(["me"], me);
  vi.spyOn(api, "me").mockResolvedValue(me);
  vi.spyOn(api, "listProjects").mockResolvedValue(available);

  const rootRoute = createRootRoute({ component: NewIssueButton });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
  });
  const projectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects",
    validateSearch: (s) => s,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const projectIndexRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    validateSearch: (s) => s,
  });
  const boardRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "board",
  });
  const newIssueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/new",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      inboxRoute,
      projectsRoute,
      projectRoute.addChildren([projectIndexRoute, boardRoute, newIssueRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  render(
    <QueryClientProvider client={c}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function openPicker() {
  const trigger = await screen.findByRole("button", { name: "New issue" });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("NewIssueButton inside a project (T-104)", () => {
  it("links straight to the project's new-issue page", async () => {
    const router = renderButton("/projects/alpha");
    const link = await screen.findByRole("link", { name: "New issue" });
    fireEvent.click(link);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/alpha/issues/new"),
    );
  });

  it("follows the project across nav modules, not just the list", async () => {
    const router = renderButton("/projects/beta/board");
    fireEvent.click(await screen.findByRole("link", { name: "New issue" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta/issues/new"),
    );
  });
});

describe("NewIssueButton off any project (T-104)", () => {
  it("asks which project from the inbox instead of guessing", async () => {
    const router = renderButton("/inbox");
    expect(screen.queryByRole("link", { name: "New issue" })).toBeNull();
    await openPicker();
    fireEvent.click(await screen.findByRole("menuitem", { name: "beta" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta/issues/new"),
    );
  });

  it("orders the choices by frecency, like the switcher", async () => {
    recordVisit(1, "alpha", Date.now() - 1000);
    renderButton("/projects");
    await openPicker();
    // The menu opens on a "Loading…" item; wait for the fetched list.
    await screen.findByRole("menuitem", { name: "beta" });
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("points at project creation when there is nothing to file into", async () => {
    const router = renderButton("/inbox", []);
    await openPicker();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "+ New project" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects"),
    );
    expect(router.state.location.search).toEqual({ new: true });
  });
});
