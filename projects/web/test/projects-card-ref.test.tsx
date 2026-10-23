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

/** `homelab` holds `CH`; `refract` holds a REF longer than the icon draws; `plain`
 *  holds nothing. */
const DIRECTORY: ReferenceDirectory = {
  entries: [
    {
      prefix: "CH",
      slug: "homelab",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
    {
      prefix: "REFRACT",
      slug: "refract",
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

describe("the REF on a project card", () => {
  it("draws no watermark (T-544)", async () => {
    renderProjects([project("homelab"), project("refract")], DIRECTORY);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    expect(document.querySelector('[data-slot="ref-watermark"]')).toBeNull();
    // What is left positioned on the card is the screen-reader copy alone.
    for (const slug of ["homelab", "refract"]) {
      const positioned = [...cardOf(slug).querySelectorAll("*")].filter(
        (node) =>
          (node.getAttribute("class") ?? "")
            .split(/\s+/)
            .some((token) => token === "absolute" || token === "sr-only"),
      );
      expect(positioned.map((node) => node.className)).toEqual(["sr-only"]);
    }
  });

  it("still reaches a screen reader whole, and only where there is one", async () => {
    renderProjects(
      [project("homelab"), project("refract"), project("plain")],
      DIRECTORY,
    );
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    expect(cardOf("homelab").querySelector(".sr-only")?.textContent).toBe("CH");
    expect(cardOf("refract").querySelector(".sr-only")?.textContent).toBe(
      "REFRACT",
    );
    expect(cardOf("plain").querySelector(".sr-only")).toBeNull();
    // Read after the name, as the watermark was.
    expect(cardOf("homelab").lastElementChild?.className).toBe("sr-only");
  });

  it("stands on cards the page has made the same height", async () => {
    // Three classes hold even rows up together: without `auto-rows-fr` a row
    // sizes itself, without `h-full` the card does not take the row's
    // height, and without the clamp every card on the page pays the tallest
    // one's height. (The heights themselves are a browser check — happy-dom
    // reports every offsetHeight as 0.)
    renderProjects([project("homelab"), project("plain")], DIRECTORY);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    const card = cardOf("homelab");
    expect(card.parentElement?.parentElement?.className).toContain(
      "auto-rows-fr",
    );
    expect(card.className).toContain("h-full");
    expect(
      card.querySelector('[data-slot="card-description"]')?.className,
    ).toContain("line-clamp-3");
  });
});
