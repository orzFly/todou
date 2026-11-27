import {
  type AnyRoute,
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
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSettingsLayout } from "../src/pages/project-settings.tsx";
import { UserSettingsLayout } from "../src/pages/user-settings-layout.tsx";

const happyDom = globalThis as unknown as {
  happyDOM: { setViewport: (viewport: { width?: number }) => void };
};

const USER = [
  ["Profile", "/settings/profile"],
  ["Appearance", "/settings/appearance"],
  ["Inbox", "/settings/inbox"],
  ["Agents", "/settings/agents"],
  ["Personal tokens", "/settings/tokens"],
] as const;

const PROJECT = [
  ["General", "/projects/p/settings"],
  ["Members", "/projects/p/settings/members"],
  ["Statuses", "/projects/p/settings/statuses"],
  ["Labels", "/projects/p/settings/labels"],
  ["References", "/projects/p/settings/references"],
] as const;

/**
 * Both layouts at the real paths, with every category's page stubbed to
 * nothing: what is under test is the nav, which only reads the URL.
 * `/authed` mirrors the app's id prefix, which the project layout's
 * `useParams({ from })` names.
 */
function renderAt(url: string) {
  const rootRoute = createRootRoute();
  const authed = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: Outlet,
  });
  const child = (parent: AnyRoute, path: string, extra: object = {}) =>
    createRoute({
      getParentRoute: () => parent,
      path,
      component: () => null,
      ...extra,
    });
  const user = createRoute({
    getParentRoute: () => authed,
    path: "/settings",
    component: UserSettingsLayout,
  });
  const project = createRoute({
    getParentRoute: () => authed,
    path: "/projects/$slug",
    component: Outlet,
  });
  const projectSettings = createRoute({
    getParentRoute: () => project,
    path: "settings",
    component: ProjectSettingsLayout,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authed.addChildren([
        user.addChildren(
          ["profile", "appearance", "inbox", "tokens", "agents/$login"]
            .map((path) => child(user, path))
            .concat(
              child(user, "agents", {
                validateSearch: (s: Record<string, unknown>) => s,
              }),
            ),
        ),
        project.addChildren([
          projectSettings.addChildren(
            ["/", "members", "statuses", "labels", "references"].map((path) =>
              child(projectSettings, path),
            ),
          ),
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

async function navLinks(label: string) {
  const nav = await screen.findByRole("navigation", { name: label });
  return within(nav).getAllByRole("link");
}

const marked = (links: HTMLElement[]) =>
  links
    .filter((a) => a.hasAttribute("aria-current"))
    .map((a) => [a.textContent, a.getAttribute("aria-current")]);

describe("settings categories are links (T-557)", () => {
  for (const [label, items] of [
    ["Account settings", USER],
    ["Project settings", PROJECT],
  ] as const) {
    describe(label, () => {
      it("gives every category its own address, in order", async () => {
        renderAt(items[0][1]);
        const links = await navLinks(label);
        expect(
          links.map((a) => [a.textContent, a.getAttribute("href")]),
        ).toEqual(items.map(([name, href]) => [name, href]));
      });

      for (const [name, href] of items) {
        it(`marks only ${name} as current at ${href}`, async () => {
          renderAt(href);
          expect(marked(await navLinks(label))).toEqual([[name, "page"]]);
        });
      }

      it("puts one nav in the page", async () => {
        renderAt(items[0][1]);
        await navLinks(label);
        expect(
          document.querySelectorAll(`nav[aria-label="${label}"]`),
        ).toHaveLength(1);
      });
    });
  }

  it("keeps Agents the current page on its Deactivated segment, a search param", async () => {
    renderAt("/settings/agents?state=deactivated");
    expect(marked(await navLinks("Account settings"))).toEqual([
      ["Agents", "page"],
    ]);
  });

  it("marks Agents as the location on one agent's page beneath it", async () => {
    renderAt("/settings/agents/bot-one");
    expect(marked(await navLinks("Account settings"))).toEqual([
      ["Agents", "location"],
    ]);
  });
});

describe("below md the categories are in a sheet", () => {
  afterEach(() => happyDom.happyDOM.setViewport({ width: 1024 }));

  function renderNarrow(url: string) {
    happyDom.happyDOM.setViewport({ width: 700 });
    return renderAt(url);
  }

  const button = () => screen.findByRole("button", { name: /Members/ });

  it("names the current category on the button, and keeps the nav out of the page until opened", async () => {
    renderNarrow("/projects/p/settings/members");
    expect((await button()).textContent).toBe("Members");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("opens a sheet holding the same links", async () => {
    renderNarrow("/projects/p/settings/members");
    fireEvent.click(await button());
    const sheet = await screen.findByRole("dialog", {
      name: "Project settings",
    });
    const links = within(
      within(sheet).getByRole("navigation", { name: "Project settings" }),
    ).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual(
      PROJECT.map(([name, href]) => [name, href]),
    );
    expect(marked(links)).toEqual([["Members", "page"]]);
  });

  it("goes to a category on a plain click and closes the sheet", async () => {
    const router = renderNarrow("/projects/p/settings/members");
    fireEvent.click(await button());
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("link", { name: "Labels" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/projects/p/settings/labels",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      (await screen.findByRole("button", { name: /Labels/ })).textContent,
    ).toBe("Labels");
  });

  it("leaves a modified click to the browser and keeps the sheet open", async () => {
    const router = renderNarrow("/projects/p/settings/members");
    fireEvent.click(await button());
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("link", { name: "Labels" }), {
      ctrlKey: true,
    });
    expect(screen.getByRole("dialog")).toBe(sheet);
    expect(router.state.location.pathname).toBe("/projects/p/settings/members");
  });
});
