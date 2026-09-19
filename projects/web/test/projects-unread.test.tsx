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
import { InboxPage as InboxPageView } from "../src/pages/inbox.tsx";
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

function inboxItem(slug: string, number: number): InboxPage["items"][number] {
  return {
    id: number,
    number,
    title: `issue ${number}`,
    status: {
      id: 1,
      name: "Todo",
      category: "open",
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
    project: project(slug),
    last_activity_at: "2026-01-02T00:00:00Z",
    pending_spec_review: false,
    mentions_you: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** As in projects-order, the route id is /authed/projects for useSearch. */
function renderProjects({
  projects,
  inbox,
  includeNav = false,
  includeInbox = false,
  getInbox,
}: {
  projects: Project[];
  inbox?: InboxPage;
  includeNav?: boolean;
  includeInbox?: boolean;
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
  if (includeInbox) {
    client.setQueryData(["mutes"], { issues: [], projects: [] });
    client.setQueryDefaults(["mutes"], { staleTime: Infinity });
    vi.spyOn(api, "getReferenceDirectory").mockResolvedValue({
      entries: [],
      contested: [],
    });
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
        {includeInbox && <InboxPageView />}
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
      screen.getByRole("link", { name: /Alpha description.*2 unread/ }),
    ).toBe(alpha);
    expect(actionOf(quiet)).toBeNull();
    expect(quiet.textContent).not.toContain("unread");
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
    const alphaRow = inboxItem("alpha", 1);
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
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    const alphaOption = await screen.findByRole("option", {
      name: "alpha — 120 unread",
    });
    const betaOption = screen.getByRole("option", { name: "beta — 3 unread" });
    expect(
      alphaOption.querySelector(
        '[data-slot="project-spelling"] + span[aria-hidden]',
      )?.textContent,
    ).toBe("99+");
    expect(
      betaOption.querySelector(
        '[data-slot="project-spelling"] + span[aria-hidden]',
      )?.textContent,
    ).toBe("3");
    expect(inboxSpy).not.toHaveBeenCalled();
  });
});

describe("Mark all read badge coherence (T-444)", () => {
  function expectCounts(container: HTMLElement, alpha: number, beta = 0) {
    const total = alpha + beta;
    const navbar = screen.getByRole("link", {
      name: total > 0 ? `Inbox — ${total} unread` : "Inbox",
    });
    expect(navbar.querySelector("span[aria-hidden]")?.textContent).toBe(
      total > 0 ? String(total) : undefined,
    );
    for (const [slug, count] of [
      ["alpha", alpha],
      ["beta", beta],
    ] as const) {
      const option = screen.getByRole("option", {
        name: count > 0 ? `${slug} — ${count} unread` : `${slug} ${slug}`,
      });
      expect(
        option.querySelector(
          '[data-slot="project-spelling"] + span[aria-hidden]',
        )?.textContent,
      ).toBe(count > 0 ? String(count) : undefined);
      const action = actionOf(cardOf(container, slug));
      if (count === 0) expect(action).toBeNull();
      else {
        expect(action?.querySelector("span[aria-hidden]")?.textContent).toBe(
          String(count),
        );
      }
    }
  }

  it("clears all three badge surfaces before the sweep responds and accepts later server counts", async () => {
    const sweep = deferred<void>();
    const refresh = deferred<InboxPage>();
    const mark = vi.spyOn(api, "markAllRead").mockReturnValue(sweep.promise);
    const { container, client, inboxSpy } = renderProjects({
      projects: [project("alpha"), project("beta")],
      inbox: page(
        { alpha: 3 },
        [1, 2, 3].map((number) => inboxItem("alpha", number)),
      ),
      includeNav: true,
      includeInbox: true,
      getInbox: () => refresh.promise,
    });
    await screen.findByText("issue 3");
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    await screen.findByRole("option", { name: "alpha — 3 unread" });
    expectCounts(container, 3);
    fireEvent.click(
      screen.getByRole("button", { name: "Mark the inbox as read" }),
    );

    // Separate the row assertion from the badge assertion: reverting only
    // the count patch must leave an empty inbox here but turn the test red.
    await screen.findByText(/Inbox all dug out/);
    expect(client.getQueryData<InboxPage>(["inbox"])?.items).toEqual([]);
    await waitFor(() => expectCounts(container, 0));
    expect(mark).toHaveBeenCalledWith({});
    expect(inboxSpy).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Mark the inbox as read" })
        .hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => sweep.resolve());
    await waitFor(() => expect(inboxSpy).toHaveBeenCalledTimes(1));
    // The success response alone must not resurrect the old counts while
    // its invalidated GET is still pending.
    expectCounts(container, 0);
    expect(screen.getByText(/Inbox all dug out/)).toBeTruthy();

    await act(async () =>
      refresh.resolve(
        page({ alpha: 2, beta: 1 }, [
          inboxItem("alpha", 4),
          inboxItem("alpha", 5),
          inboxItem("beta", 6),
        ]),
      ),
    );
    await screen.findByText("issue 6");
    await waitFor(() => expectCounts(container, 2, 1));
    expect(screen.queryByText(/Inbox all dug out/)).toBeNull();
  });

  it("rolls back rows and all badges on failure, preserving other projects and cached inbox variants", async () => {
    const sweep = deferred<void>();
    const refresh = deferred<InboxPage>();
    const mark = vi.spyOn(api, "markAllRead").mockReturnValue(sweep.promise);
    const original = page({ alpha: 3, beta: 1 }, [
      ...[1, 2, 3].map((number) => inboxItem("alpha", number)),
      inboxItem("beta", 4),
    ]);
    const { container, client, inboxSpy } = renderProjects({
      projects: [project("alpha"), project("beta")],
      inbox: original,
      includeNav: true,
      includeInbox: true,
      getInbox: () => refresh.promise,
    });
    const limitedKey = ["inbox", { projects: ["alpha"], limit: 1 }];
    const limited = page({ alpha: 3 }, [inboxItem("alpha", 1)]);
    const otherKey = ["inbox", { projects: ["beta"] }];
    const other = page({ beta: 1 }, [inboxItem("beta", 4)]);
    client.setQueryData(limitedKey, limited);
    client.setQueryData(otherKey, other);
    await screen.findByText("issue 3");
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    await screen.findByRole("option", { name: "alpha — 3 unread" });
    expectCounts(container, 3, 1);
    fireEvent.click(screen.getByRole("button", { name: "Mark alpha as read" }));
    await waitFor(() => expectCounts(container, 0, 1));
    expect(screen.queryByText("issue 1")).toBeNull();
    expect(screen.getByText("issue 4")).toBeTruthy();
    expect(mark).toHaveBeenCalledWith({ projects: ["alpha"] });
    expect(inboxSpy).not.toHaveBeenCalled();
    // This cached variant did not return two rows. Their reasons are
    // unknown, so the provisional count must not claim they disappeared.
    expect(client.getQueryData<InboxPage>(limitedKey)).toEqual({
      items: [],
      unread_counts: { alpha: 2 },
      truncated: true,
    });
    expect(client.getQueryData(otherKey)).toEqual(other);

    await act(async () => sweep.reject(new Error("read failed")));
    await waitFor(() => expect(inboxSpy).toHaveBeenCalledTimes(1));
    // The retry GET remains deferred, so this recovery is the rollback.
    await waitFor(() => expectCounts(container, 3, 1));
    expect(screen.getByText("issue 1")).toBeTruthy();
    expect(client.getQueryData(["inbox"])).toEqual(original);
    expect(client.getQueryData(limitedKey)).toEqual(limited);
    expect(client.getQueryData(otherKey)).toEqual(other);
    await act(async () => refresh.resolve(original));
  });
});
