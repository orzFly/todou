import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Me } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/shell.tsx";
import { testQueryClient } from "./render.tsx";

const autoHide = vi.hoisted(() => ({ enabled: [] as boolean[] }));

// The real hook, with what the shell asks of it written down on the way.
vi.mock("@orz/ui/hooks/viewport-chrome", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@orz/ui/hooks/viewport-chrome")>();
  return {
    ...actual,
    useAutoHideHeader: (
      ...args: Parameters<typeof actual.useAutoHideHeader>
    ) => {
      autoHide.enabled.push(args[1]);
      return actual.useAutoHideHeader(...args);
    },
  };
});

const happyDom = globalThis as unknown as {
  happyDOM: { setViewport: (viewport: { width?: number }) => void };
};

afterEach(() => {
  happyDom.happyDOM.setViewport({ width: 1024 });
  autoHide.enabled.length = 0;
});

const me: Me = {
  id: 1,
  login: "user",
  display_name: "Some User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

async function renderShellAt(
  url: string,
  {
    width = 1024,
    mode = "single",
    notice,
  }: { width?: number; mode?: string; notice?: ReactNode } = {},
) {
  happyDom.happyDOM.setViewport({ width });
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <AppShell me={me} notice={notice}>
          <Outlet />
        </AppShell>
      </QueryClientProvider>
    ),
  });
  const leaf = (path: string, parent = rootRoute) =>
    createRoute({
      getParentRoute: () => parent,
      path,
      component: () => null,
      validateSearch: (s: Record<string, unknown>) => s,
    });
  const project = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: Outlet,
    validateSearch: (s: Record<string, unknown>) => s,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      leaf("/projects"),
      leaf("/inbox"),
      leaf("/settings/profile"),
      project.addChildren(
        ["/", "board", "settings", "settings/members", "issues/new"].map(
          (path) =>
            createRoute({
              getParentRoute: () => project,
              path,
              component: () => null,
              validateSearch: (s: Record<string, unknown>) => s,
            }),
        ),
      ),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const view = render(<RouterProvider router={router} />);
  await screen.findByRole("banner");
  return { ...view, router };
}

const header = (view: { container: HTMLElement }) =>
  view.container.querySelector("header") as HTMLElement;

const ROUTES = [
  "/projects",
  "/projects/p",
  "/projects/p/board?x=1",
  "/projects/p/settings/members",
  "/projects/p/issues/new",
  "/inbox",
  "/settings/profile",
];

describe("the header marks one place (T-795)", () => {
  for (const width of [390, 700, 1280]) {
    for (const url of ROUTES) {
      it(`at ${url}, ${width}px wide`, async () => {
        const view = await renderShellAt(url, { width });
        await within(header(view)).findByRole("link", { name: "todou" });
        const project = url.startsWith("/projects/");
        if (project) {
          await within(header(view)).findByRole("link", { name: "List" });
        }
        expect(
          header(view).querySelectorAll("[aria-current]").length,
        ).toBeLessThanOrEqual(1);
        expect(
          header(view).querySelectorAll('nav[aria-label="Project"]'),
        ).toHaveLength(project ? 1 : 0);
      });
    }
  }

  it("marks the brand link on the projects page, which has no tabs", async () => {
    const view = await renderShellAt("/projects");
    const brand = await within(header(view)).findByRole("link", {
      name: "todou",
    });
    expect(brand.getAttribute("aria-current")).toBe("page");
  });

  it("leaves the breadcrumb unmarked on the List page, where the List tab says it", async () => {
    const view = await renderShellAt("/projects/p");
    const list = await within(header(view)).findByRole("link", {
      name: "List",
    });
    expect(list.getAttribute("aria-current")).toBe("page");
    const crumb = header(view).querySelector(
      'a[href="/projects/p"]:not([data-slot="tab-nav-link"])',
    );
    expect(crumb).not.toBeNull();
    expect(crumb?.hasAttribute("aria-current")).toBe(false);
  });

  it("names the brand link todou on a project page too", async () => {
    const view = await renderShellAt("/projects/p");
    const brand = await within(header(view)).findByRole("link", {
      name: "todou",
    });
    expect(brand.getAttribute("href")).toBe("/projects");
  });
});

async function openAccountMenu(mode = "single") {
  const view = await renderShellAt("/projects", { mode });
  const trigger = await within(header(view)).findByText("Some User");
  fireEvent.pointerDown(trigger.closest("button") ?? trigger, {
    button: 0,
    pointerType: "mouse",
  });
  return within(await screen.findByRole("menu"));
}

describe("the account menu", () => {
  it("names the account by display name and login", async () => {
    const menu = await openAccountMenu();
    const label = menu.getByText("@user").parentElement as HTMLElement;
    expect(label.textContent).toBe("Some User@user");
  });

  it("lists every settings category, grouped as the settings page groups them", async () => {
    const menu = await openAccountMenu();
    const content = menu
      .getAllByRole("menuitem")
      .map((el) => [el.textContent?.trim(), el.getAttribute("href")]);
    expect(content).toEqual([
      ["Profile", "/settings/profile"],
      ["Appearance", "/settings/appearance"],
      ["Inbox", "/settings/inbox"],
      ["Agents", "/settings/agents"],
      ["Personal tokens", "/settings/tokens"],
      ["Log out", null],
    ]);
    const headings = [
      ...(screen
        .getByRole("menu")
        .querySelectorAll('[data-slot="dropdown-menu-label"]') ?? []),
    ].map((el) => el.textContent);
    expect(headings).toEqual(["Some User@user", "Preferences", "Access"]);
  });

  it("offers no Log out in forward mode", async () => {
    const menu = await openAccountMenu("forward");
    expect(menu.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Profile",
      "Appearance",
      "Inbox",
      "Agents",
      "Personal tokens",
    ]);
  });
});

describe("the header's auto-hide", () => {
  it("slides away on a phone", async () => {
    const view = await renderShellAt("/projects/p", { width: 390 });
    await within(header(view)).findByRole("link", { name: "List" });
    expect(autoHide.enabled.at(-1)).toBe(true);
  });

  it("stays put on a phone while a notice is up", async () => {
    const view = await renderShellAt("/projects/p", {
      width: 390,
      notice: <div role="status">Reconnecting</div>,
    });
    await within(header(view)).findByRole("link", { name: "List" });
    await waitFor(() => expect(autoHide.enabled.at(-1)).toBe(false));
    expect(autoHide.enabled).not.toContain(true);
  });

  it("stays put on a wide screen", async () => {
    const view = await renderShellAt("/projects/p", { width: 1280 });
    await within(header(view)).findByRole("link", { name: "List" });
    expect(autoHide.enabled.at(-1)).toBe(false);
  });
});
