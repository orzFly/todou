import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectSettingsLayout } from "../src/pages/project-settings.tsx";
import { UserSettingsLayout } from "../src/pages/user-settings-layout.tsx";

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
  ["Insights", "/projects/p/settings/insights"],
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
          ["profile", "appearance", "inbox", "tokens"]
            .map((path) => child(user, path))
            .concat(
              child(user, "agents", {
                validateSearch: (s: Record<string, unknown>) => s,
              }),
            ),
        ),
        project.addChildren([
          projectSettings.addChildren(
            [
              "/",
              "members",
              "statuses",
              "labels",
              "references",
              "insights",
            ].map((path) => child(projectSettings, path)),
          ),
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(<RouterProvider router={router} />);
}

async function navLinks(label: string) {
  const nav = await screen.findByRole("navigation", { name: label });
  return within(nav).getAllByRole("link");
}

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
          const links = await navLinks(label);
          const current = links.filter(
            (a) => a.getAttribute("aria-current") === "page",
          );
          expect(current.map((a) => a.textContent)).toEqual([name]);
        });
      }
    });
  }

  it("keeps Agents current on its Deactivated segment", async () => {
    renderAt("/settings/agents?state=deactivated");
    const current = (await navLinks("Account settings")).filter(
      (a) => a.getAttribute("aria-current") === "page",
    );
    expect(current.map((a) => a.textContent)).toEqual(["Agents"]);
  });
});
