import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Me } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { ProjectNav } from "../src/components/project-nav.tsx";
import { AppShell } from "../src/components/shell.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/** ProjectNav's active states depend on the URL, so the shim mounts it at the real paths. */
function renderNavAt(url: string) {
  const rootRoute = createRootRoute();
  function NavAtSlug() {
    const { slug } = useParams({ strict: false });
    return <ProjectNav slug={slug ?? ""} />;
  }
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: NavAtSlug,
    validateSearch: (s) => s,
  });
  const boardRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "board",
    component: NavAtSlug,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "settings",
    component: NavAtSlug,
  });
  const newIssueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/new",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      projectRoute.addChildren([boardRoute, settingsRoute, newIssueRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

async function status(name: string) {
  const el = await screen.findByRole("link", { name });
  return el.getAttribute("data-status");
}

describe("ProjectNav active states (T-79)", () => {
  it("keeps List highlighted when filter search params are set", async () => {
    renderNavAt("/projects/x?category=closed");
    await waitFor(async () => expect(await status("List")).toBe("active"));
    expect(await status("Board")).not.toBe("active");
  });

  it("highlights List on the bare list URL", async () => {
    renderNavAt("/projects/x");
    await waitFor(async () => expect(await status("List")).toBe("active"));
  });

  it("highlights Board, not List, on the board page", async () => {
    renderNavAt("/projects/x/board");
    await waitFor(async () => expect(await status("Board")).toBe("active"));
    expect(await status("List")).not.toBe("active");
  });
});

describe("ProjectNav create entry (T-104)", () => {
  it("sits at the end of the row, after Settings", async () => {
    renderNavAt("/projects/x");
    await screen.findByRole("link", { name: "New issue" });
    const labels = screen
      .getAllByRole("link")
      .map((el) => el.textContent?.trim());
    expect(labels).toEqual(["List", "Board", "Settings", "New issue"]);
  });

  it("files into the project of the module you are looking at", async () => {
    const router = renderNavAt("/projects/beta/settings");
    fireEvent.click(await screen.findByRole("link", { name: "New issue" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta/issues/new"),
    );
  });
});

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

describe("AppShell off any project (T-104)", () => {
  it("drops the nav, and the create entry with it", async () => {
    const client = testQueryClient();
    client.setQueryData(["auth-mode"], { mode: "single" });
    // renderWithProviders mounts at "/", where no slug is in scope.
    const view = renderWithProviders(<AppShell me={me}>x</AppShell>, client);
    await view.findByText("todou");
    expect(screen.queryByRole("link", { name: "New issue" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });
});
