import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { Project, ReferenceDirectory } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import { ProjectsPage } from "../src/pages/projects.tsx";
import { testQueryClient } from "./render.tsx";

function project(slug: string): Project {
  return {
    id: slug.length,
    slug,
    name: slug,
    description: "",
    created_at: "2026-01-01T00:00:00Z",
  };
}

const me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

/** `homelab` holds `CH`; `plain` holds nothing. */
const DIRECTORY: ReferenceDirectory = {
  entries: [
    {
      prefix: "CH",
      slug: "homelab",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
  ],
  contested: [],
};

function renderProjects(projects: Project[], directory?: ReferenceDirectory) {
  const client = testQueryClient();
  client.setQueryData(["me"], me);
  client.setQueryData(["projects"], projects);
  if (directory) {
    client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  }
  vi.spyOn(api, "me").mockResolvedValue(me);
  vi.spyOn(api, "listProjects").mockResolvedValue(projects);

  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects",
    component: ProjectsPage,
    validateSearch: (): { new?: boolean } => ({}),
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectsRoute, projectRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/projects"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The card element for a project, by the link wrapping it. */
function cardOf(slug: string): HTMLElement {
  const link = document.querySelector(`a[href="/projects/${slug}"]`);
  return link?.firstElementChild as HTMLElement;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the REF watermark on a project card", () => {
  /** The watermark on a card, or null where it has none. */
  const watermarkOf = (slug: string) =>
    cardOf(slug).querySelector('[data-slot="ref-watermark"]');

  it("is drawn for a project with a REF and not for one without", async () => {
    renderProjects([project("homelab"), project("plain")], DIRECTORY);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());

    expect(watermarkOf("homelab")?.textContent).toBe("CH");
    expect(watermarkOf("plain")).toBeNull();
  });

  it("is absent for every card while the directory is unavailable", async () => {
    renderProjects([project("homelab"), project("plain")]);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    expect(watermarkOf("homelab")).toBeNull();
  });

  it("floats out of flow, after the header, and stays readable", async () => {
    renderProjects([project("homelab")], DIRECTORY);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    const card = cardOf("homelab");
    // Queried by slot: the card's icon falls back to the REF as well, so the
    // text "CH" is on this card twice.
    const mark = card.querySelector(
      '[data-slot="ref-watermark"]',
    ) as HTMLElement;

    // Absolutely positioned inside a `relative` card: out of flow, so it
    // cannot push the card taller than one without a watermark. (The height
    // itself is a browser check — happy-dom reports every offsetHeight as 0,
    // so asserting it here could never fail.)
    expect(mark.className).toContain("absolute");
    expect(card.className).toContain("relative");

    // After the header, so a screen reader reaches it last…
    expect(card.lastElementChild).toBe(mark);
    // …and reaches it at all: with no badge on this card, the watermark is
    // the only place the REF appears.
    expect(mark.getAttribute("aria-hidden")).toBe(null);
  });
});
