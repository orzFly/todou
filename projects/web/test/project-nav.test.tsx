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
import type { Me } from "@todou/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { NewIssueButton, ProjectNav } from "../src/components/project-nav.tsx";
import { AppShell } from "../src/components/shell.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * ProjectNav's active states depend on the URL, so the shim mounts it at the
 * real paths. `ui` swaps in whatever the case is about — the nav alone, the
 * create button beside it, or the whole shell.
 */
function renderAt(url: string, ui: (slug: string) => ReactElement) {
  const rootRoute = createRootRoute();
  function AtSlug() {
    const { slug } = useParams({ strict: false });
    return ui(slug ?? "");
  }
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: AtSlug,
    validateSearch: (s) => s,
  });
  const children = ["board", "settings", "issues/new", "search"].map((path) =>
    createRoute({
      getParentRoute: () => projectRoute,
      path,
      component: AtSlug,
      ...(path === "search"
        ? { validateSearch: (s: Record<string, unknown>) => s }
        : {}),
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute.addChildren(children)]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

function renderNavAt(url: string, withCreate = false) {
  return renderAt(url, (slug) => (
    <>
      <ProjectNav slug={slug} />
      {withCreate && <NewIssueButton slug={slug} />}
    </>
  )).router;
}

/** The real header, for the cases about where things sit in it. */
function renderShellAt(url: string) {
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode: "single" });
  return renderAt(url, () => (
    <QueryClientProvider client={client}>
      <AppShell me={me}>x</AppShell>
    </QueryClientProvider>
  ));
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

describe("ProjectNav tabs", () => {
  it("carries the three modules and nothing else", async () => {
    renderNavAt("/projects/x");
    await screen.findByRole("link", { name: "List" });
    const labels = screen
      .getAllByRole("link")
      .map((el) => el.textContent?.trim());
    expect(labels).toEqual(["List", "Board", "Settings"]);
  });
});

describe("New issue entry (T-104)", () => {
  it("files into the project of the module you are looking at", async () => {
    const router = renderNavAt("/projects/beta/settings", true);
    fireEvent.click(await screen.findByRole("link", { name: "New issue" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta/issues/new"),
    );
  });

  it("keeps its name where the label is hidden", async () => {
    // Below `sm` the label is display:none, which no screen reader reads —
    // the accessible name has to come from somewhere else (T-215).
    renderNavAt("/projects/x", true);
    const link = await screen.findByRole("link", { name: "New issue" });
    expect(link.getAttribute("aria-label")).toBe("New issue");
    expect(link.querySelector("span")?.className).toContain("hidden");
  });
});

describe("the header's second row (T-215)", () => {
  it("puts the search box before the create button", async () => {
    // Both used to fight the nav for the same row, and the box lost: at
    // 390 it came out 50px wide, too narrow for the jump offer under it.
    const view = renderShellAt("/projects/x");
    await view.findAllByLabelText("Search this project");
    const box = view.container.querySelector("input[name='q']") as Element;
    const create = view.container.querySelector(
      'a[aria-label="New issue"]',
    ) as Element;
    expect(
      box.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leaves the nav's row to the tabs and the box", async () => {
    const view = renderShellAt("/projects/x");
    await view.findAllByLabelText("Search this project");
    const secondRow = view.container.querySelector(".md\\:hidden");
    expect(secondRow?.querySelector("nav")).not.toBeNull();
    expect(secondRow?.querySelector("input[name='q']")).not.toBeNull();
    expect(secondRow?.querySelector('a[aria-label="New issue"]')).toBeNull();
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
