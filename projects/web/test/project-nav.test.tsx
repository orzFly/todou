import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectNav } from "../src/components/project-nav.tsx";

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
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      projectRoute.addChildren([boardRoute, settingsRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  return render(<RouterProvider router={router} />);
}

async function status(name: string) {
  const el = await screen.findByRole("link", { name });
  return el.getAttribute("data-status");
}

describe("ProjectNav active states (#79)", () => {
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
