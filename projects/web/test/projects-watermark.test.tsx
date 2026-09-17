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

/** `homelab` holds `CH`; `refract` holds one too long to draw whole; `plain`
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

  it("cuts a REF too long for the mark and keeps it whole for a reader", async () => {
    renderProjects([project("refract")], DIRECTORY);
    await waitFor(() => expect(cardOf("refract")).toBeTruthy());

    const mark = watermarkOf("refract") as Element;
    expect(mark.textContent).toBe("REFR");
    expect(mark.getAttribute("aria-label")).toBe("REFRACT");
  });

  it("is absent for every card while the directory is unavailable", async () => {
    renderProjects([project("homelab"), project("plain")]);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    expect(watermarkOf("homelab")).toBeNull();
  });

  it("takes no part in the text: nothing is reserved for it", async () => {
    // The mark is a background, so the description is laid out as if it were
    // not there — it may run straight over it. The clamp below is the one
    // truncation on this card, and it is about card height, not about the
    // mark.
    renderProjects([project("homelab")], DIRECTORY);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    const card = cardOf("homelab");
    const desc = card.querySelector('[data-slot="card-description"]');
    expect(desc?.className ?? "").not.toContain("truncate");
    expect(desc?.className ?? "").not.toMatch(/\bpr-/);
    expect((desc as HTMLElement).style.paddingRight).toBe("");
  });

  it("stands on cards the page has made the same height", async () => {
    // One size for every mark only holds while every card is one size, and
    // three classes hold that up together: without `auto-rows-fr` a row sizes
    // itself, without `h-full` the card does not take the row's height, and
    // without the clamp every card on the page pays the tallest one's height.
    // (The heights themselves are a browser check — happy-dom reports every
    // offsetHeight as 0, so asserting one here could never fail.)
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

  it("is inert: it takes no clicks and joins no selection", async () => {
    renderProjects([project("homelab")], DIRECTORY);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    const mark = watermarkOf("homelab") as HTMLElement;
    expect(mark.className).toContain("pointer-events-none");
    expect(mark.className).toContain("select-none");
  });

  it("is painted under the card's own text", async () => {
    // happy-dom lays nothing out, so the paint order itself is a browser
    // check; what is assertable here is the pair of classes that produce it.
    renderProjects([project("homelab")], DIRECTORY);
    await waitFor(() => expect(cardOf("homelab")).toBeTruthy());
    const card = cardOf("homelab");
    expect((watermarkOf("homelab") as HTMLElement).className).toContain("z-0");
    const header = card.querySelector('[data-slot="card-header"]');
    expect(header?.className).toContain("z-10");
    expect(header?.className).toContain("relative");
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
