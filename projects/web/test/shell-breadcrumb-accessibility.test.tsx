import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor, within } from "@testing-library/react";
import type { Project, ReferenceDirectory } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authModeQuery,
  projectQuery,
  projectsQuery,
} from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import { AppShell } from "../src/components/shell.tsx";
import { testQueryClient } from "./render.tsx";
import { expectVisible } from "./visibility.ts";

const project: Project = {
  id: 1,
  slug: "atlas",
  name: "Atlas Lab",
  description: "",
  created_at: "2026-01-01T00:00:00Z",
};
const directory: ReferenceDirectory = {
  entries: [
    { prefix: "XYZ", slug: project.slug, from: project.created_at, to: null },
  ],
  contested: [],
};

function renderBreadcrumb(iconUrl: string | null = null) {
  const client = testQueryClient();
  const data = { ...project, icon_url: iconUrl };
  client.setQueryData(projectQuery(project.slug).queryKey, data);
  client.setQueryData(projectsQuery.queryKey, [data]);
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  client.setQueryData(authModeQuery.queryKey, { mode: "single" });
  const rootRoute = createRootRoute();
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: () => <AppShell>Project content</AppShell>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute]),
    history: createMemoryHistory({ initialEntries: ["/projects/atlas"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("shell project breadcrumb accessible name", () => {
  it("shows the fallback prefix while naming the link only for the project", async () => {
    const view = renderBreadcrumb();
    const header = within(await view.findByRole("banner"));
    const link = header.getByRole("link", { name: "Atlas Lab" });

    expectVisible(within(link).getByText("XYZ", { exact: true }));
    expect(link.getAttribute("href")).toBe("/projects/atlas");
    expect(header.queryByRole("link", { name: "XYZ Atlas Lab" })).toBeNull();
  });

  it("draws an uploaded image with the same exact breadcrumb name", async () => {
    class LoadedImage extends EventTarget {
      complete = true;
      naturalWidth = 20;
      crossOrigin: string | null = null;
      referrerPolicy = "";
      src = "";
    }
    vi.stubGlobal("Image", LoadedImage);
    const iconUrl = "/api/projects/1/icon?v=breadcrumb";
    const view = renderBreadcrumb(iconUrl);
    const header = within(await view.findByRole("banner"));
    const link = header.getByRole("link", { name: "Atlas Lab" });

    await waitFor(() => {
      const image = link.querySelector("img");
      expect(image?.getAttribute("src")).toBe(iconUrl);
      expectVisible(image as HTMLImageElement);
      expect(within(link).queryByText("XYZ", { exact: true })).toBeNull();
    });
    expect(header.getByRole("link", { name: "Atlas Lab" })).toBe(link);
    // Empty alt independently protects the loaded-image name. The fallback
    // case is what detects removal of the breadcrumb icon's hide.
    expect(within(link).queryByRole("img")).toBeNull();
  });
});
