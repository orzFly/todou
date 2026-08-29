import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectQuery } from "../src/api/queries.ts";
import { ProjectLayout } from "../src/pages/project-layout.tsx";
import { SlugSection } from "../src/pages/project-settings.tsx";
import { testQueryClient } from "./render.tsx";

const PROJECT: Project = {
  id: 1,
  slug: "todou",
  name: "todou",
  description: "The tracker itself.",
  created_at: "2026-08-01T00:00:00.000Z",
  former_slugs: ["todo-u", "todou-old"],
};

type Call = { url: string; method?: string; body?: string };

/** Answers PATCH with `responses` in order, everything else with the project. */
function stubFetch(responses: Response[] = []): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    if (init?.method === "PATCH" && responses.length > 0) {
      return responses.shift() as Response;
    }
    return new Response(JSON.stringify(PROJECT), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Mounts `ui` at /projects/$slug/settings so useNavigate has a real target. */
function renderAtSettings(slug: string, ui: React.ReactElement) {
  const client = testQueryClient();
  client.setQueryData(projectQuery(slug).queryKey, PROJECT);
  const rootRoute = createRootRoute();
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const settingsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "settings",
    component: () => ui,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      projectRoute.addChildren([settingsRoute]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/projects/${slug}/settings`],
    }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SlugSection", () => {
  it("lists the retired slugs that still point here", async () => {
    stubFetch();
    renderAtSettings("todou", <SlugSection slug="todou" />);
    expect(await screen.findByText("todo-u")).toBeTruthy();
    expect(screen.getByText("todou-old")).toBeTruthy();
  });

  it("renames and moves the browser to the new address", async () => {
    const calls = stubFetch([
      jsonResponse(200, { ...PROJECT, slug: "todou2", former_slugs: [] }),
    ]);
    const router = renderAtSettings("todou", <SlugSection slug="todou" />);
    const input = await screen.findByLabelText("project slug");
    fireEvent.change(input, { target: { value: "todou2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/todou2/settings"),
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ slug: "todou2" });
  });

  it("asks before taking over a slug that still redirects elsewhere", async () => {
    const reserved = {
      error: {
        code: "slug_reserved",
        message: "reserved",
        details: { slug: "taken" },
      },
    };
    const calls = stubFetch([
      jsonResponse(409, reserved),
      jsonResponse(200, { ...PROJECT, slug: "taken", former_slugs: [] }),
    ]);
    const router = renderAtSettings("todou", <SlugSection slug="todou" />);
    const input = await screen.findByLabelText("project slug");
    fireEvent.change(input, { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    const confirm = await screen.findByRole("button", {
      name: "Take it over anyway",
    });
    // The first attempt must not have carried reclaim on its own.
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ slug: "taken" });

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/taken/settings"),
    );
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(JSON.parse(patches[1]?.body ?? "{}")).toEqual({
      slug: "taken",
      reclaim: true,
    });
  });
});

describe("ProjectLayout canonical redirect", () => {
  /** Mounts the layout under a retired slug the server resolves elsewhere. */
  function renderLayoutAt(url: string) {
    const client = testQueryClient();
    const rootRoute = createRootRoute();
    // The layout reads its params strictly, from "/authed/projects/$slug" —
    // the shim tree has to carry the same pathless "authed" id.
    const authedRoute = createRoute({
      getParentRoute: () => rootRoute,
      id: "authed",
    });
    const projectRoute = createRoute({
      getParentRoute: () => authedRoute,
      path: "/projects/$slug",
      component: ProjectLayout,
    });
    const issuesRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "issues/$number",
      component: () => <div>issue</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        authedRoute.addChildren([projectRoute.addChildren([issuesRoute])]),
      ]),
      history: createMemoryHistory({ initialEntries: [url] }),
    });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return router;
  }

  it("swaps a retired slug for the current one, keeping the deep link", async () => {
    stubFetch();
    const router = renderLayoutAt("/projects/todou-old/issues/12");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/todou/issues/12"),
    );
  });

  it("stays put when the slug is already current", async () => {
    stubFetch();
    const router = renderLayoutAt("/projects/todou/issues/12");
    await waitFor(() => expect(screen.getByText("issue")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/projects/todou/issues/12");
  });
});
