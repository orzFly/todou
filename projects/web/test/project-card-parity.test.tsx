import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type {
  Project,
  PublicUser,
  ReferenceDirectory,
  UserMembership,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import { userQuery } from "../src/api/users.ts";
import { recordVisit } from "../src/lib/project-visits.ts";
import { ProjectsPage } from "../src/pages/projects.tsx";
import { UserProfilePage } from "../src/pages/user-profile.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * The projects home and the user page's seats draw one card (T-390), so what
 * is asserted here is that they are the same thing and not two things that
 * look alike. Whether the card itself is right belongs to
 * projects-watermark.test.tsx and project-watermark-size.test.tsx.
 */

const reader = {
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

const alice: PublicUser = {
  id: 7,
  login: "alice",
  display_name: "Alice Potato",
  kind: "human",
  avatar_url: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
};

function project(slug: string, name: string, description = ""): Project {
  return {
    id: PROJECT_IDS[slug] ?? 99,
    slug,
    name,
    description,
    icon_url: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

const PROJECT_IDS: Record<string, number> = {
  homelab: 1,
  refract: 2,
  pathological: 3,
  plain: 4,
};

/** A seat, carrying the `ProjectBrief` the user endpoint really answers with. */
function seat(p: Project, role: UserMembership["role"]): UserMembership {
  return {
    project: { id: p.id, slug: p.slug, name: p.name, icon_url: p.icon_url },
    role,
    created_at: "2026-05-02T11:03:21.000Z",
  };
}

const LONG = "W".repeat(20);

/** `plain` holds no claim; the other three hold one each. */
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
    {
      prefix: LONG,
      slug: "pathological",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
  ],
  contested: [],
};

function client(projects: Project[], directory?: ReferenceDirectory) {
  const c = testQueryClient();
  c.setQueryData(["me"], reader);
  c.setQueryData(["projects"], projects);
  c.setQueryData(userQuery(alice.login).queryKey, alice);
  const inbox = { items: [], truncated: false, unread_counts: {} };
  c.setQueryData(["inbox"], inbox);
  vi.spyOn(api, "getInbox").mockResolvedValue(inbox);
  if (directory) {
    c.setQueryData(referenceDirectoryQuery.queryKey, directory);
  }
  vi.spyOn(api, "me").mockResolvedValue(reader);
  vi.spyOn(api, "listProjects").mockResolvedValue(projects);
  return c;
}

/**
 * Both pages against one fixture. The visits are seeded because the home
 * dims a project nobody has opened, and on an empty localStorage that is
 * every project — the two pages would then differ on a class that has
 * nothing to do with this card.
 */
function renderBoth(
  projects: Project[],
  seats: UserMembership[],
  directory?: ReferenceDirectory,
) {
  for (const p of projects) recordVisit(reader.id, p.slug, Date.now());
  const shared = client(projects, directory);
  vi.spyOn(api, "listUserProjects").mockResolvedValue({ items: seats });
  vi.spyOn(api, "listUserIssues").mockResolvedValue({
    items: [],
    next_cursor: null,
    has_more: false,
  });

  const home = renderHome(shared);
  const user = renderWithProviders(<UserProfilePage ref="alice" />, shared);
  return { home: home.container, user: user.container };
}

/** The home needs its own shim: it reads `/authed/projects`' search params. */
function renderHome(c: ReturnType<typeof testQueryClient>) {
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
    <QueryClientProvider client={c}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The link a page drew for a project, which is the card's outermost node. */
function linkOf(container: HTMLElement, slug: string): HTMLElement {
  const link = container.querySelector(`a[href="/projects/${slug}"]`);
  if (!link?.firstElementChild) throw new Error(`no card for ${slug}`);
  return link as HTMLElement;
}

/** The card a page drew for a project, by the link wrapping it. */
function cardOf(container: HTMLElement, slug: string): HTMLElement {
  return linkOf(container, slug).firstElementChild as HTMLElement;
}

async function bothCards(
  container: { home: HTMLElement; user: HTMLElement },
  slug: string,
) {
  await waitFor(() => {
    expect(cardOf(container.home, slug)).toBeTruthy();
    expect(cardOf(container.user, slug)).toBeTruthy();
  });
  return {
    home: cardOf(container.home, slug),
    user: cardOf(container.user, slug),
    link: {
      home: linkOf(container.home, slug),
      user: linkOf(container.user, slug),
    },
    grid: {
      home: gridOf(container.home, slug),
      user: gridOf(container.user, slug),
    },
  };
}

/**
 * One line per node: tag, `data-slot`, and the classes sorted so a reordered
 * `cn` call is not a difference. Text is left out — it is the one thing the
 * two pages are allowed to differ on, and the description is asserted on its
 * own below. An array rather than a string so a failure names the node.
 */
function signature(root: Element): string[] {
  const lines: string[] = [];
  const walk = (el: Element, depth: number) => {
    lines.push(`${"· ".repeat(depth)}${nodeLine(el)}`);
    for (const child of el.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return lines;
}

function nodeLine(el: Element): string {
  const slot = el.getAttribute("data-slot") ?? "-";
  return `${el.tagName.toLowerCase()} ${slot} ${[...el.classList].sort().join(" ")}`;
}

/**
 * The element the cards are laid out in. Read off a card rather than queried,
 * so a page that lays its cards out in something else is caught rather than
 * skipped.
 */
function gridOf(container: HTMLElement, slug: string): HTMLElement {
  const grid = linkOf(container, slug).parentElement;
  if (!grid) throw new Error(`no grid around ${slug}`);
  return grid;
}

/**
 * The seats card carries one node the home's does not. It is dropped by
 * naming its slot, not by deleting whatever happens to differ — the slot is
 * the component's own and a rename of it has to fail this.
 */
function withoutBadge(card: HTMLElement): Element {
  const clone = card.cloneNode(true) as HTMLElement;
  const badge = clone.querySelectorAll('[data-slot="project-card-badge"]');
  expect(badge).toHaveLength(1);
  for (const node of badge) node.remove();
  return clone;
}

const textOf = (card: HTMLElement, slot: string) =>
  card.querySelector(`[data-slot="${slot}"]`)?.textContent;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the project card, drawn by both pages (T-390)", () => {
  it("comes out with the same structure on each, with no action wrappers on quiet home or user cards", async () => {
    const homelab = project(
      "homelab",
      "Homelab",
      "Every machine under the sink",
    );
    const containers = renderBoth(
      [homelab],
      [seat(homelab, "admin")],
      DIRECTORY,
    );
    const card = await bothCards(containers, "homelab");
    // Equal signatures alone cannot catch an empty action added to both
    // pages: it silently activates CardHeader's two-column layout on both.
    for (const page of ["user", "home"] as const) {
      const header = card[page].querySelector('[data-slot="card-header"]');
      expect(header, `${page} card header`).not.toBeNull();
      expect(
        header?.querySelector('[data-slot="card-action"]'),
        `${page} must not activate the action layout`,
      ).toBeNull();
    }
    const role = card.user.querySelector('[data-slot="project-card-badge"]');
    expect(role?.textContent).toBe("admin");
    expect(role?.parentElement?.getAttribute("data-slot")).toBe("card-title");
    expect(
      card.home.querySelector('[data-slot="project-card-badge"]'),
    ).toBeNull();

    // Rooted at the link, not at the card: the anchor is part of what the
    // component owns, and a page that hung a class of its own on it would
    // otherwise pass.
    expect(signature(withoutBadge(card.link.user))).toEqual(
      signature(card.link.home),
    );
  });

  it("lays the cards out in the same grid on each", async () => {
    // The card's own signature cannot see this, and the three classes that
    // hold every watermark on a page to one size are split across the pair:
    // a page that kept the card and spelled its own container would draw
    // marks at one size per card with nothing wrong in the card to find.
    const homelab = project("homelab", "Homelab");
    const containers = renderBoth(
      [homelab],
      [seat(homelab, "admin")],
      DIRECTORY,
    );
    const card = await bothCards(containers, "homelab");

    expect(nodeLine(card.grid.user)).toBe(nodeLine(card.grid.home));
    expect(card.grid.home.className).toContain("auto-rows-fr");
  });

  it("writes the same description on each, from the same field", async () => {
    // The seats endpoint answers with `ProjectBrief`s, which carry no
    // description: this is the one assertion that the user page joins the
    // project list to get it, and that it joins it into the same sentence.
    const homelab = project(
      "homelab",
      "Homelab",
      "Every machine under the sink",
    );
    const containers = renderBoth(
      [homelab],
      [seat(homelab, "admin")],
      DIRECTORY,
    );
    const card = await bothCards(containers, "homelab");

    expect(textOf(card.home, "card-description")).toBe(
      "homelab — Every machine under the sink",
    );
    expect(textOf(card.user, "card-description")).toBe(
      textOf(card.home, "card-description"),
    );
  });

  it("keeps the role badge out of the description slot", async () => {
    // The role is the title row's trailing element, so the description stays
    // the home's own sentence and the card gains exactly one node.
    const homelab = project(
      "homelab",
      "Homelab",
      "Every machine under the sink",
    );
    const containers = renderBoth(
      [homelab],
      [seat(homelab, "admin")],
      DIRECTORY,
    );
    const card = await bothCards(containers, "homelab");

    const slot = card.user.querySelector(
      '[data-slot="project-card-badge"]',
    ) as HTMLElement;
    expect(slot.textContent).toBe("admin");
    expect(slot.closest('[data-slot="card-title"]')).toBeTruthy();
    // Pushed to the far right, which is what puts a column of roles on one
    // vertical line whatever the project names are.
    expect(slot.className).toContain("ml-auto");
    // Not interactive: this card is already one anchor, and a nested control
    // would both be invalid HTML and split it into two focusable things.
    expect(slot.querySelector("button, a, input")).toBeNull();
  });

  it("falls back to the same glyphs on each, branch for branch", async () => {
    // Literals, not `GLYPH_LIMIT` / `WATERMARK_EMS` recomputed — an expected
    // value derived from the constant moves with it and can never fail.
    const projects = [
      project("homelab", "Homelab"),
      project("refract", "Refract"),
      project("pathological", "Pathological"),
      project("plain", "Home Lab"),
    ];
    const containers = renderBoth(
      projects,
      projects.map((p) => seat(p, "reader")),
      DIRECTORY,
    );

    const expected: Record<string, { icon: string; mark: string | null }> = {
      homelab: { icon: "CH", mark: "CH" },
      refract: { icon: "REF", mark: "REFR" },
      pathological: { icon: "WWW", mark: "WWWW" },
      plain: { icon: "HL", mark: null },
    };
    for (const [slug, want] of Object.entries(expected)) {
      const card = await bothCards(containers, slug);
      for (const page of ["home", "user"] as const) {
        expect(
          textOf(card[page], "avatar-fallback"),
          `${slug} icon on ${page}`,
        ).toBe(want.icon);
        expect(
          textOf(card[page], "ref-watermark") ?? null,
          `${slug} mark on ${page}`,
        ).toBe(want.mark);
      }
    }
  });

  it("takes the REF from the directory on each, never from the slug", async () => {
    // With no directory there is no prefix anywhere, so the icon falls all
    // the way through to initials and no mark is drawn. A page that minted a
    // prefix of its own out of the slug would draw `HOM` and a watermark.
    const homelab = project("homelab", "Homelab");
    const containers = renderBoth([homelab], [seat(homelab, "writer")]);
    const card = await bothCards(containers, "homelab");

    for (const page of ["home", "user"] as const) {
      expect(textOf(card[page], "avatar-fallback"), `icon on ${page}`).toBe(
        "H",
      );
      expect(
        card[page].querySelector('[data-slot="ref-watermark"]'),
      ).toBeNull();
    }
  });
});
