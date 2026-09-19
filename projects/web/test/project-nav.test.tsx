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
  const children = [
    "board",
    "insights",
    "settings",
    "issues/new",
    "search",
  ].map((path) =>
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

/** The labels standing on the row itself, in order; the `···` reads as "More". */
function rowLabels() {
  const nav = screen.getByRole("navigation");
  return [...nav.children].map((el) =>
    el.tagName === "BUTTON"
      ? el.getAttribute("aria-label")
      : el.textContent?.trim(),
  );
}

/** Opens the `···`, and hands back what it offers. */
async function openMore() {
  fireEvent.pointerDown(await screen.findByRole("button", { name: "More" }), {
    button: 0,
    pointerType: "mouse",
  });
  const menu = await screen.findByRole("menu");
  return within(menu);
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

  it.each(["", "?range=30d&bucket=week"])(
    "highlights Insights independently of search params (%s)",
    async (search) => {
      renderNavAt(`/projects/x/insights${search}`);
      await waitFor(async () =>
        expect(await status("Insights")).toBe("active"),
      );
      expect(await status("List")).not.toBe("active");
      expect(await status("Board")).not.toBe("active");
    },
  );
});

describe("the ··· menu (T-454)", () => {
  it("leaves only List and Board on the row", async () => {
    renderNavAt("/projects/x");
    await screen.findByRole("link", { name: "List" });
    expect(rowLabels()).toEqual(["List", "Board", "More"]);
  });

  it("keeps Insights and Settings reachable behind it", async () => {
    renderNavAt("/projects/beta");
    const menu = await openMore();
    expect(
      menu.getAllByRole("menuitem").map((el) => el.textContent?.trim()),
    ).toEqual(["Insights", "Settings"]);
    expect(
      menu.getByRole("menuitem", { name: "Insights" }).getAttribute("href"),
    ).toBe("/projects/beta/insights");
  });

  it("pulls the module you are in onto the row, and marks it in both places", async () => {
    renderNavAt("/projects/x/settings");
    await waitFor(async () => expect(await status("Settings")).toBe("active"));
    // Between Board and the `···`, as its own tab rather than in place of one.
    expect(rowLabels()).toEqual(["List", "Board", "Settings", "More"]);

    const menu = await openMore();
    const entry = menu.getByRole("menuitem", { name: "Settings" });
    expect(entry.getAttribute("data-status")).toBe("active");
    expect(entry.getAttribute("aria-current")).toBe("page");
    // Still offered, alongside the one you are not in.
    expect(
      menu.getByRole("menuitem", { name: "Insights" }).getAttribute("href"),
    ).toBe("/projects/x/insights");
  });

  /**
   * Tailwind is not loaded here, so the width bands are only readable as class
   * names — these evaluate the variant chains the component actually ships.
   */
  const matchesVariant = (variant: string, width: number): boolean => {
    const min = /^min-\[(\d+)px\]$/.exec(variant);
    if (min) return width >= Number(min[1]);
    const max = /^max-\[(\d+)px\]$/.exec(variant);
    if (max) return width < Number(max[1]);
    if (variant === "sm") return width >= 640;
    if (variant === "max-sm") return width < 640;
    throw new Error(
      `the bands grew a variant this case cannot read: ${variant}`,
    );
  };

  /** Does `className` land `utility` at `width`? Variants are ANDed, as Tailwind stacks them. */
  const appliesAt = (
    className: string,
    utility: string,
    width: number,
  ): boolean =>
    className
      .split(/\s+/)
      .filter(Boolean)
      .some((entry) => {
        const parts = entry.split(":");
        // Only the utility under test is read, so `hover:` and friends never
        // reach the variant reader — and a width variant it cannot read still
        // throws rather than quietly answering false.
        if (parts.pop() !== utility) return false;
        return parts.every((v) => matchesVariant(v, width));
      });

  const WIDTHS = [320, 359, 360, 500, 639, 640, 700, 800, 863, 864, 1000, 1400];

  it("never leaves the row with nothing lit, and never lights two things", async () => {
    renderNavAt("/projects/x/settings");
    const tab = await screen.findByRole("link", { name: "Settings" });
    const more = screen.getByRole("button", { name: "More" });

    const both = WIDTHS.map((width) => ({
      width,
      // A later variant rule beats the bare `hidden`, as the cascade does.
      onRow: appliesAt(tab.className, "block", width),
      marked: appliesAt(more.className, "bg-accent", width),
    }));
    // The two bands have to partition the width axis: wherever the module is
    // not standing on the row, the `···` is what says the reader is inside it.
    expect(both.filter((b) => b.onRow === b.marked)).toEqual([]);
    expect(both.filter((b) => b.onRow).map((b) => b.width)).toEqual([
      360, 500, 639, 864, 1000, 1400,
    ]);
  });

  it("leaves the ··· unmarked while nothing of its own is active", async () => {
    renderNavAt("/projects/x/board");
    const more = await screen.findByRole("button", { name: "More" });
    expect(more.className).not.toContain("bg-accent");
  });

  it("pulls nothing out for a module that stands on the row anyway", async () => {
    renderNavAt("/projects/x/board");
    await waitFor(async () => expect(await status("Board")).toBe("active"));
    expect(rowLabels()).toEqual(["List", "Board", "More"]);
  });

  it("navigates from the menu into the current project", async () => {
    const router = renderNavAt("/projects/beta");
    const menu = await openMore();
    fireEvent.click(menu.getByRole("menuitem", { name: "Insights" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/beta/insights"),
    );
    await waitFor(async () => expect(await status("Insights")).toBe("active"));
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

describe("where the create button sits (T-232)", () => {
  /**
   * Both rows are in the DOM at once — which one a reader sees is CSS, and
   * no CSS is loaded here — so each case reads the row it is about.
   */
  async function rowsOf(url: string) {
    const view = renderShellAt(url);
    await view.findAllByLabelText("Search this project");
    const header = view.container.querySelector("header") as Element;
    return { first: header.children[0], second: header.children[1] };
  }

  it("keeps it after the search box on the first row", async () => {
    const { first } = await rowsOf("/projects/x");
    const box = first.querySelector("input[name='q']") as Element;
    const create = first.querySelector('a[aria-label="New issue"]') as Element;
    expect(
      box.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("moves it down to the project row, which has no box to share with", async () => {
    const { second } = await rowsOf("/projects/x");
    expect(second.querySelector("nav")).not.toBeNull();
    expect(second.querySelector('a[aria-label="New issue"]')).not.toBeNull();
    expect(second.querySelector("input[name='q']")).toBeNull();
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
