import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { ProjectSwitcher } from "../src/components/project-switcher.tsx";
import { recordVisit, visitsKey } from "../src/lib/project-visits.ts";
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

/**
 * The switcher needs live routes to land its navigations somewhere; the
 * project subtree mirrors the app's so module keeping sees the real shapes.
 */
function renderSwitcher(projects: Project[], at = "/") {
  const c = testQueryClient();
  c.setQueryData(["me"], me);
  c.setQueryData(["projects"], projects);
  vi.spyOn(api, "me").mockResolvedValue(me);
  vi.spyOn(api, "listProjects").mockResolvedValue(projects);

  function SwitcherAtSlug() {
    const { slug } = useParams({ strict: false });
    return <ProjectSwitcher slug={slug ?? "alpha"} />;
  }
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: SwitcherAtSlug,
  });
  const projectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects",
    validateSearch: (s) => s,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: SwitcherAtSlug,
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
  const settingsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "settings",
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectsRoute,
      projectRoute.addChildren([
        projectIndexRoute,
        boardRoute,
        settingsRoute,
        issueRoute,
      ]),
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

async function openSwitcher() {
  const trigger = await screen.findByRole("button", { name: "切换项目" });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
  return trigger;
}

// Distinct ages: same-age projects would tie on created_at and leave the
// zero-score tail order at the mercy of module-load millisecond boundaries.
// Without visits the order is [gamma, beta, alpha] (newest creation first).
const fewProjects = [
  project("alpha", 300),
  project("beta", 200),
  project("gamma", 100),
];
const manyProjects = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
].map((s) => project(s));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ProjectSwitcher", () => {
  it("opens a listbox with the current project checked", async () => {
    renderSwitcher(fewProjects);
    await openSwitcher();
    const current = screen
      .getAllByRole("option")
      .find((el) => el.textContent?.includes("alpha"));
    expect(current?.getAttribute("aria-selected")).toBe("true");
  });

  it("orders by frecency: a visit beats newer creation dates", async () => {
    recordVisit(1, "alpha", Date.now() - 1000);
    renderSwitcher(fewProjects);
    await openSwitcher();
    const names = screen.getAllByRole("option").map((el) => el.textContent);
    expect(names[0]).toContain("alpha");
  });

  it("hides the search box below 8 projects, shows it at 8", async () => {
    renderSwitcher(fewProjects);
    await openSwitcher();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("filters by name/slug and shows an empty state on no match", async () => {
    renderSwitcher(manyProjects);
    await openSwitcher();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zeta" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    fireEvent.change(input, { target: { value: "no-such" } });
    await waitFor(() =>
      expect(screen.getByText("没有匹配的项目")).toBeTruthy(),
    );
  });

  it("walks with arrows and navigates with Enter to the project home", async () => {
    const router = renderSwitcher(fewProjects);
    await openSwitcher();
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta"),
    );
  });

  it("floats fresh projects by creation bonus, with no badge (T-87)", async () => {
    renderSwitcher([...fewProjects, project("newborn", 2)]);
    await openSwitcher();
    const names = screen.getAllByRole("option").map((el) => el.textContent);
    expect(names[0]).toContain("newborn");
    expect(names[0]).not.toContain("新");
  });

  it("still renders when localStorage is unavailable", async () => {
    const denied = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    renderSwitcher(fewProjects);
    await openSwitcher();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    denied.mockRestore();
  });

  it("records the visit key per user", () => {
    recordVisit(1, "todou", Date.now());
    expect(localStorage.getItem(visitsKey(1))).toBeTruthy();
    expect(localStorage.getItem(visitsKey(2))).toBeNull();
  });
});

async function pickProject(name: string) {
  const option = screen
    .getAllByRole("option")
    .find((el) => el.textContent?.includes(name));
  if (!option) throw new Error(`no option for ${name}`);
  fireEvent.click(option);
}

describe("ProjectSwitcher keeps the nav module (T-94)", () => {
  it("switches board to board", async () => {
    const router = renderSwitcher(fewProjects, "/projects/alpha/board");
    await openSwitcher();
    await pickProject("beta");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta/board"),
    );
  });

  it("switches settings to settings", async () => {
    const router = renderSwitcher(fewProjects, "/projects/alpha/settings");
    await openSwitcher();
    await pickProject("beta");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta/settings"),
    );
  });

  it("switches list to list without the old search params", async () => {
    const router = renderSwitcher(
      fewProjects,
      "/projects/alpha?category=closed&q=x",
    );
    await openSwitcher();
    await pickProject("beta");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta"),
    );
    expect(router.state.location.search).toEqual({});
  });

  it("falls back to the list from an issue detail page", async () => {
    const router = renderSwitcher(fewProjects, "/projects/alpha/issues/7");
    await openSwitcher();
    await pickProject("beta");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta"),
    );
  });
});
