import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { recordVisit } from "../src/lib/project-visits.ts";
import { ProjectsPage } from "../src/pages/projects.tsx";
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

/** ProjectsPage reads /authed/projects search, so the shim mirrors those route ids. */
function renderProjects(projects: Project[], url = "/projects") {
  const client = testQueryClient();
  client.setQueryData(["me"], me);
  client.setQueryData(["projects"], projects);
  vi.spyOn(api, "me").mockResolvedValue(me);
  vi.spyOn(api, "listProjects").mockResolvedValue(projects);

  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects",
    component: ProjectsPage,
    validateSearch: (search): { new?: boolean } =>
      search.new === true || search.new === 1 || search.new === "1"
        ? { new: true }
        : {},
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectsRoute, projectRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ProjectsPage ordering (T-76)", () => {
  it("renders cards in frecency order, never-visited trailing newest-first", async () => {
    recordVisit(1, "busy", Date.now() - 1000);
    renderProjects([
      project("old-never", 400),
      project("newer-never", 100),
      project("busy", 300),
    ]);
    await waitFor(() => expect(screen.getAllByRole("heading")).toBeTruthy());
    const titles = screen
      .getAllByRole("link")
      .map((el) => el.textContent ?? "")
      .filter((t) => t.includes("never") || t.includes("busy"));
    expect(titles[0]).toContain("busy");
    expect(titles[1]).toContain("newer-never");
    expect(titles[2]).toContain("old-never");
  });

  it("floats fresh projects by creation bonus, with no badge (T-87)", async () => {
    renderProjects([project("plain", 300), project("newborn", 2)]);
    // The name shows up in both the card title and the slug line.
    const [title] = await screen.findAllByText("newborn");
    expect(title.closest("a")?.textContent).not.toContain("新");
    const titles = screen
      .getAllByRole("link")
      .map((el) => el.textContent ?? "")
      .filter((t) => t.includes("plain") || t.includes("newborn"));
    expect(titles[0]).toContain("newborn");
  });

  it("opens the create dialog when arriving as /projects?new=1", async () => {
    renderProjects([project("plain")], "/projects?new=1");
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("New project"),
    );
  });

  it("keeps the dialog closed on the bare URL", async () => {
    renderProjects([project("plain")]);
    await screen.findAllByText("plain");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
