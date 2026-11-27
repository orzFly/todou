import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type NavPlace, useNavCurrent } from "../src/lib/nav-current.ts";

const LIST: NavPlace = {
  to: "/projects/$slug",
  params: { slug: "p" },
  exact: true,
};
const SETTINGS: NavPlace = {
  to: "/projects/$slug/settings",
  params: { slug: "p" },
  exact: false,
};

function Probe({ places }: { places: Record<string, NavPlace> }) {
  const current = useNavCurrent();
  return (
    <dl>
      {Object.entries(places).map(([name, place]) => (
        <div key={name} data-testid={name}>
          {String(current(place))}
        </div>
      ))}
    </dl>
  );
}

async function currentAt(url: string, places: Record<string, NavPlace>) {
  const rootRoute = createRootRoute();
  const component = () => <Probe places={places} />;
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component,
    validateSearch: (s) => s,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "settings",
    component,
  });
  const membersRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "members",
    component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      projectRoute.addChildren([settingsRoute.addChildren([membersRoute])]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(<RouterProvider router={router} />);
  const names = Object.keys(places);
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = (await screen.findAllByTestId(name))[0]?.textContent ?? "";
  }
  return out;
}

describe("useNavCurrent", () => {
  it("marks an exact place as the page on its own address", async () => {
    expect(await currentAt("/projects/p", { list: LIST })).toEqual({
      list: "page",
    });
  });

  it("leaves an exact place unmarked on the pages beneath it", async () => {
    expect(await currentAt("/projects/p/settings", { list: LIST })).toEqual({
      list: "false",
    });
  });

  it("marks a fuzzy place as the page on its own address", async () => {
    expect(
      await currentAt("/projects/p/settings", { settings: SETTINGS }),
    ).toEqual({ settings: "page" });
  });

  it("marks a fuzzy place as the location on a page beneath it", async () => {
    expect(
      await currentAt("/projects/p/settings/members", {
        settings: SETTINGS,
        list: LIST,
      }),
    ).toEqual({ settings: "location", list: "false" });
  });

  it("ignores search params", async () => {
    expect(
      await currentAt("/projects/p?category=closed&sort=updated", {
        list: LIST,
      }),
    ).toEqual({ list: "page" });
  });

  it("does not mark another project's place", async () => {
    expect(
      await currentAt("/projects/q/settings/members", { settings: SETTINGS }),
    ).toEqual({ settings: "false" });
  });
});
