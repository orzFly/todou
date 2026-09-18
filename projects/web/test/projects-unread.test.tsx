import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { InboxPage, Project } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { InboxButton } from "../src/components/inbox-button.tsx";
import { ProjectSwitcher } from "../src/components/project-switcher.tsx";
import { ProjectsPage } from "../src/pages/projects.tsx";
import { testQueryClient } from "./render.tsx";

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

function project(slug: string, description = ""): Project {
  return {
    id: ["alpha", "beta", "quiet"].indexOf(slug) + 1,
    slug,
    name: slug,
    description,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function page(
  unread_counts: Record<string, number>,
  items: InboxPage["items"] = [],
): InboxPage {
  return {
    items,
    truncated:
      items.length <
      Object.values(unread_counts).reduce((total, count) => total + count, 0),
    unread_counts,
  };
}

/** As in projects-order, the route id is /authed/projects for useSearch. */
function renderProjects({
  projects,
  inbox,
  includeNav = false,
  getInbox,
}: {
  projects: Project[];
  inbox?: InboxPage;
  includeNav?: boolean;
  getInbox?: () => Promise<InboxPage>;
}) {
  const client = testQueryClient();
  client.setQueryData(["me"], me);
  client.setQueryData(["projects"], projects);
  vi.spyOn(api, "me").mockResolvedValue(me);
  vi.spyOn(api, "listProjects").mockResolvedValue(projects);
  if (inbox) {
    client.setQueryData(["inbox"], inbox);
    // Keep the seeded snapshot stable: cache updates must not depend on HTTP.
    client.setQueryDefaults(["inbox"], { staleTime: Infinity });
  }
  const inboxSpy = vi
    .spyOn(api, "getInbox")
    .mockImplementation(getInbox ?? (() => new Promise<InboxPage>(() => {})));

  function Home() {
    return (
      <>
        {includeNav && (
          <nav>
            <InboxButton />
            <ProjectSwitcher slug="alpha" />
          </nav>
        )}
        <ProjectsPage />
      </>
    );
  }
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects",
    component: Home,
    validateSearch: (): { new?: boolean } => ({}),
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const inboxRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/inbox",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectsRoute, projectRoute, inboxRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/projects"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, client, inboxSpy };
}

/** The whole linked ProjectCard, not the page heading or the switcher row. */
function cardOf(container: HTMLElement, slug: string): HTMLAnchorElement {
  const card = container.querySelector<HTMLAnchorElement>(
    `a[href="/projects/${slug}"]`,
  );
  if (!card?.querySelector('[data-slot="card-header"]')) {
    throw new Error(`missing project card: ${slug}`);
  }
  return card;
}

function actionOf(card: HTMLAnchorElement) {
  return card.querySelector(
    '[data-slot="card-header"] [data-slot="card-action"]',
  );
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ProjectsPage unread badges (T-382)", () => {
  it("places positive counts in ProjectCard header actions, preserves description in the accessible link name, and omits quiet actions", async () => {
    const { container } = renderProjects({
      projects: [
        project("alpha", "Alpha description"),
        project("beta"),
        project("quiet"),
      ],
      inbox: page({ alpha: 2, beta: 1 }),
    });
    await waitFor(() =>
      expect(actionOf(cardOf(container, "alpha"))).not.toBeNull(),
    );
    const alpha = cardOf(container, "alpha");
    const beta = cardOf(container, "beta");
    const quiet = cardOf(container, "quiet");
    expect(
      actionOf(alpha)?.querySelector("span[aria-hidden]")?.textContent,
    ).toBe("2");
    expect(
      actionOf(beta)?.querySelector("span[aria-hidden]")?.textContent,
    ).toBe("1");
    expect(
      alpha.querySelector('[data-slot="card-title"] [data-slot="card-action"]'),
    ).toBeNull();
    expect(actionOf(alpha)?.parentElement?.getAttribute("data-slot")).toBe(
      "card-header",
    );
    expect(alpha.getAttribute("aria-label")).toBeNull();
    expect(
      screen.getByRole("link", { name: /Alpha description.*2 未读/ }),
    ).toBe(alpha);
    expect(actionOf(quiet)).toBeNull();
    expect(quiet.textContent).not.toContain("未读");
  });

  it("keeps cards and hrefs visible without badges while the inbox is loading", async () => {
    const { container } = renderProjects({
      projects: [project("alpha"), project("beta")],
    });
    await waitFor(() => expect(cardOf(container, "alpha")).toBeTruthy());
    for (const slug of ["alpha", "beta"]) {
      expect(cardOf(container, slug).getAttribute("href")).toBe(
        `/projects/${slug}`,
      );
      expect(actionOf(cardOf(container, slug))).toBeNull();
    }
  });

  it("keeps cards and hrefs visible without badges when the inbox request fails", async () => {
    const { container, client } = renderProjects({
      projects: [project("alpha"), project("beta")],
      getInbox: () => Promise.reject(new Error("inbox unavailable")),
    });
    await waitFor(() =>
      expect(client.getQueryState(["inbox"])?.status).toBe("error"),
    );
    for (const slug of ["alpha", "beta"]) {
      expect(cardOf(container, slug).getAttribute("href")).toBe(
        `/projects/${slug}`,
      );
      expect(actionOf(cardOf(container, slug))).toBeNull();
    }
  });

  it("updates the existing card from the inbox cache without remounting or fetching", async () => {
    const { container, client, inboxSpy } = renderProjects({
      projects: [project("alpha")],
      inbox: page({ alpha: 1 }),
    });
    await waitFor(() =>
      expect(actionOf(cardOf(container, "alpha"))?.textContent).toContain("1"),
    );
    const card = cardOf(container, "alpha");
    await act(async () => {
      client.setQueryData(["inbox"], page({ alpha: 3 }));
    });
    await waitFor(() =>
      expect(
        actionOf(card)?.querySelector("span[aria-hidden]")?.textContent,
      ).toBe("3"),
    );
    expect(cardOf(container, "alpha")).toBe(card);
    expect(inboxSpy).not.toHaveBeenCalled();
  });

  it("uses exact truncated unread_counts for navbar total, switcher row, and home card", async () => {
    // One returned alpha row cannot explain the 120-server-count badge;
    // summing items or grouping them by slug must fail here.
    const alphaRow = {
      id: 1,
      number: 1,
      title: "issue 1",
      status: {
        id: 1,
        name: "Todo",
        category: "open" as const,
        color: "#000000",
        position: 1,
        is_default: false,
      },
      author: me,
      assignees: [],
      labels: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      body_edited_at: null,
      open_questions: 0,
      spec_version: null,
      spec_review_status: null,
      spec_unresolved_comments: 0,
      deleted_at: null,
      deleted_by: null,
      unread: true,
      unread_comments: 1,
      muted: null,
      blocked_by: [],
      blocks: [],
      moves: [],
      project: { id: 5, slug: "alpha", name: "alpha" },
      last_activity_at: "2026-01-02T00:00:00Z",
      pending_spec_review: false,
      mentions_you: false,
    } satisfies InboxPage["items"][number];
    const { container, inboxSpy } = renderProjects({
      projects: [project("alpha"), project("beta")],
      inbox: page({ alpha: 120, beta: 3 }, [alphaRow]),
      includeNav: true,
    });
    await waitFor(() =>
      expect(actionOf(cardOf(container, "alpha"))?.textContent).toContain(
        "99+",
      ),
    );
    const navbar = screen.getByRole("link", { name: "Inbox — 123 unread" });
    expect(navbar.querySelector("span[aria-hidden]")?.textContent).toBe("99+");
    expect(
      actionOf(cardOf(container, "alpha"))?.querySelector("span[aria-hidden]")
        ?.textContent,
    ).toBe("99+");
    expect(
      actionOf(cardOf(container, "beta"))?.querySelector("span[aria-hidden]")
        ?.textContent,
    ).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    const alphaOption = await screen.findByRole("option", {
      name: "alpha — 120 未读",
    });
    const betaOption = screen.getByRole("option", { name: "beta — 3 未读" });
    expect(alphaOption.querySelector("span[aria-hidden]")?.textContent).toBe(
      "99+",
    );
    expect(betaOption.querySelector("span[aria-hidden]")?.textContent).toBe(
      "3",
    );
    expect(inboxSpy).not.toHaveBeenCalled();
  });
});
