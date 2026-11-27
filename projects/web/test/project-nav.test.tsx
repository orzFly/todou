import { TooltipProvider } from "@orz/ui/components/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Me } from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NewIssueButton, ProjectNav } from "../src/components/project-nav.tsx";
import { AppShell } from "../src/components/shell.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const happyDom = globalThis as unknown as {
  happyDOM: { setViewport: (viewport: { width?: number }) => void };
};

afterEach(() => happyDom.happyDOM.setViewport({ width: 1024 }));

/**
 * ProjectNav's current tab depends on the URL, so the shim mounts it at the
 * real paths. `ui` swaps in whatever the case is about — the nav alone, the
 * create button beside it, or the whole shell.
 */
function renderAt(url: string, ui: (slug: string) => ReactElement) {
  const rootRoute = createRootRoute();
  function AtSlug() {
    const { slug } = useParams({ strict: false });
    return <TooltipProvider>{ui(slug ?? "")}</TooltipProvider>;
  }
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: AtSlug,
    validateSearch: (s) => s,
  });
  const children = [
    "board",
    "insights",
    "settings",
    "settings/members",
    "issues/new",
    "search",
  ].map((path) =>
    createRoute({
      getParentRoute: () => projectRoute,
      path,
      component: AtSlug,
      ...(path === "search" || path === "insights"
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
function renderShellAt(url: string, width = 1024) {
  happyDom.happyDOM.setViewport({ width });
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode: "single" });
  return renderAt(url, () => (
    <QueryClientProvider client={client}>
      <AppShell me={me}>x</AppShell>
    </QueryClientProvider>
  ));
}

const nav = () => screen.getByRole("navigation", { name: "Project" });

/** The tabs on the row, in order, leaving out any the `⋯` holds. */
function rowLabels() {
  return [
    ...nav().querySelectorAll(
      '[data-slot="tab-nav-link"]:not([data-overflowed])',
    ),
  ].map((el) => el.textContent?.trim());
}

/** Each tab carrying `aria-current`, with its value. */
async function currentTabs() {
  await screen.findByRole("link", { name: "List" });
  return [...nav().querySelectorAll("a[aria-current]")].map((a) => [
    a.textContent?.trim(),
    a.getAttribute("aria-current"),
  ]);
}

describe("ProjectNav marks the module you are in (T-79)", () => {
  it("keeps List current when filter search params are set", async () => {
    renderNavAt("/projects/x?category=closed");
    expect(await currentTabs()).toEqual([["List", "page"]]);
  });

  it("marks List on the bare list URL", async () => {
    renderNavAt("/projects/x");
    expect(await currentTabs()).toEqual([["List", "page"]]);
  });

  it("marks Board, not List, on the board page", async () => {
    renderNavAt("/projects/x/board");
    expect(await currentTabs()).toEqual([["Board", "page"]]);
  });

  it.each(["", "?range=30d&bucket=week"])(
    "marks Insights independently of search params (%s)",
    async (search) => {
      renderNavAt(`/projects/x/insights${search}`);
      expect(await currentTabs()).toEqual([["Insights", "page"]]);
    },
  );

  it("marks Settings on its own page", async () => {
    renderNavAt("/projects/x/settings");
    expect(await currentTabs()).toEqual([["Settings", "page"]]);
  });

  it("marks Settings as the location on a category beneath it", async () => {
    renderNavAt("/projects/x/settings/members");
    expect(await currentTabs()).toEqual([["Settings", "location"]]);
  });

  it("marks nothing on a page that is no module's", async () => {
    renderNavAt("/projects/x/issues/new");
    expect(await currentTabs()).toEqual([]);
  });
});

describe("the project tabs (T-795)", () => {
  it("stands every module on the row, in order, each a link to it", async () => {
    renderNavAt("/projects/beta");
    await screen.findByRole("link", { name: "List" });
    expect(rowLabels()).toEqual(["List", "Board", "Insights", "Settings"]);
    expect(
      within(nav())
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/projects/beta",
      "/projects/beta/board",
      "/projects/beta/insights",
      "/projects/beta/settings",
    ]);
  });

  it("keeps the ⋯ out of the way while nothing is folded into it", async () => {
    // Folding needs widths, which happy-dom does not lay out; the real
    // browser sweep covers it. Here: nothing folded, nothing to open.
    renderNavAt("/projects/x");
    await screen.findByRole("link", { name: "List" });
    expect(screen.queryByRole("button", { name: /More sections/ })).toBeNull();
  });

  it("navigates into the current project", async () => {
    const router = renderNavAt("/projects/beta");
    fireEvent.click(await screen.findByRole("link", { name: "Insights" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta/insights"),
    );
    await waitFor(async () =>
      expect(await currentTabs()).toEqual([["Insights", "page"]]),
    );
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

  it("is named by its visible label", async () => {
    renderNavAt("/projects/x", true);
    const link = await screen.findByRole("link", { name: "New issue" });
    expect(link.getAttribute("aria-label")).toBeNull();
    expect(link.textContent).toBe("New issue");
  });

  it("is named by aria-label as an icon (T-215)", async () => {
    renderAt("/projects/x", (slug) => <NewIssueButton slug={slug} iconOnly />);
    const link = await screen.findByRole("link", { name: "New issue" });
    expect(link.getAttribute("aria-label")).toBe("New issue");
    expect(link.textContent).toBe("");
  });
});

describe("where the create button sits (T-232)", () => {
  const row = (view: { container: HTMLElement }, name: string) =>
    view.container.querySelector(`header [data-shell-row="${name}"]`);

  it("keeps it after the search box on the one row", async () => {
    const view = renderShellAt("/projects/x");
    await view.findAllByLabelText("Search this project");
    const first = row(view, "primary") as Element;
    const box = first.querySelector("input[name='q']") as Element;
    const create = within(first as HTMLElement).getByRole("link", {
      name: "New issue",
    });
    expect(
      box.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row(view, "project")).toBeNull();
  });

  it("moves it down to the project row below sm, with the tabs", async () => {
    const view = renderShellAt("/projects/x", 390);
    await view.findAllByRole("link", { name: "List" });
    const first = row(view, "primary") as HTMLElement;
    const second = row(view, "project") as HTMLElement;
    expect(second.querySelector('nav[aria-label="Project"]')).not.toBeNull();
    expect(
      within(second).getByRole("link", { name: "New issue" }),
    ).toBeTruthy();
    expect(first.querySelector("nav")).toBeNull();
    expect(within(first).queryByRole("link", { name: "New issue" })).toBeNull();
    expect(view.container.querySelectorAll("input[name='q']")).toHaveLength(0);
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

describe("ProjectNav for a guest (T-788)", () => {
  it("offers neither Insights nor Settings", async () => {
    renderAt("/projects/x", (slug) => (
      <ProjectNav slug={slug} viewerRole="guest" />
    ));
    await screen.findByRole("link", { name: "List" });
    expect(rowLabels()).toEqual(["List", "Board"]);
    expect(nav().querySelectorAll("a")).toHaveLength(2);
  });

  it("keeps both for a reader", async () => {
    renderAt("/projects/x", (slug) => (
      <ProjectNav slug={slug} viewerRole="reader" />
    ));
    await screen.findByRole("link", { name: "List" });
    expect(rowLabels()).toEqual(["List", "Board", "Insights", "Settings"]);
  });
});
