import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  PublicUser,
  UserIssueItem,
  UserIssuesPage,
  UserProjects,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import {
  userIssuesQuery,
  userProjectsQuery,
  userQuery,
  userSearchSchema,
} from "../src/api/users.ts";
import { UserProfilePage } from "../src/pages/user-profile.tsx";
import { expectVisible } from "./visibility.ts";

const alice: PublicUser = {
  id: 7,
  login: "alice",
  display_name: "Alice Potato",
  kind: "human",
  avatar_url: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
};

function makeItem(
  slug: string,
  number: number,
  overrides: Partial<UserIssueItem> = {},
): UserIssueItem {
  return {
    id: number * 1000 + slug.length,
    number,
    title: `issue ${slug} ${number}`,
    status: {
      id: 1,
      name: "Todo",
      category: "open",
      color: "#000000",
      position: 1,
      is_default: false,
    },
    author: {
      id: 7,
      login: "alice",
      display_name: "Alice Potato",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    assignees: [],
    labels: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    body_edited_at: null,
    open_questions: 0,
    spec_version: null,
    spec_review_status: null,
    spec_unresolved_comments: 0,
    deleted_at: null,
    deleted_by: null,
    unread: false,
    unread_comments: 0,
    muted: null,
    blocked_by: [],
    blocks: [],
    moves: [],
    project: { id: slug.length, slug, name: `Project ${slug}` },
    ...overrides,
  };
}

const page = (
  items: UserIssueItem[],
  next: string | null = null,
): UserIssuesPage => ({
  items,
  next_cursor: next,
  has_more: next !== null,
});

/**
 * The app's own user route at this address, carrying the router's real
 * `validateSearch` — a copy of the rule here would let the app's own drift
 * without a single test noticing.
 */
const Root = createRootRoute();

const UserRoute = createRoute({
  getParentRoute: () => Root,
  path: "/users/$ref",
  validateSearch: userSearchSchema,
  component: UserRoutePage,
});

const ProjectRoute = createRoute({
  getParentRoute: () => Root,
  path: "/projects/$slug",
});

const IssueRoute = createRoute({
  getParentRoute: () => ProjectRoute,
  path: "issues/$number",
});

const SpecRoute = createRoute({
  getParentRoute: () => ProjectRoute,
  path: "issues/$number/spec",
});

function UserRoutePage() {
  const { ref } = UserRoute.useParams();
  const { role = "any", state = "open" } = UserRoute.useSearch();
  const navigate = useNavigate();
  return (
    <UserProfilePage
      ref={ref}
      role={role}
      state={state}
      onFilters={(next) =>
        void navigate({
          to: "/users/$ref",
          params: { ref },
          search: userSearchSchema({
            role: next.role ?? role,
            state: next.state ?? state,
          }),
          replace: true,
        })
      }
    />
  );
}

function renderAt(path: string, client: QueryClient) {
  const router = createRouter({
    routeTree: Root.addChildren([
      UserRoute,
      ProjectRoute.addChildren([IssueRoute, SpecRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

function clientWithUser(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(userQuery(alice.login).queryKey, alice);
  // Two projects, two prefixes: what makes a page-level slug visibly wrong.
  client.setQueryData(referenceConfigQuery("todou").queryKey, {
    format: { prefix: "T", history: [] },
    autolinks: [],
  });
  client.setQueryData(referenceConfigQuery("kela").queryKey, {
    format: { prefix: "K", history: [] },
    autolinks: [],
  });
  client.setQueryData(referenceDirectoryQuery.queryKey, {
    entries: [],
    contested: [],
  });
  return client;
}

const noProjects = (): UserProjects => ({ items: [] });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UserIssuesSection (T-374)", () => {
  it("renders each row under its own project's ref prefix", async () => {
    vi.spyOn(api, "listUserIssues").mockResolvedValue(
      page([makeItem("todou", 12), makeItem("kela", 5)]),
    );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const view = renderAt("/users/alice", clientWithUser());
    expect(await view.findByText("T-12")).toBeTruthy();
    expect(view.getByText("K-5")).toBeTruthy();
  });

  it("draws the project icon beside a card row's project name", async () => {
    class LoadedImage extends EventTarget {
      complete = true;
      naturalWidth = 20;
      crossOrigin: string | null = null;
      referrerPolicy = "";
      src = "";
    }
    vi.stubGlobal("Image", LoadedImage);
    const iconUrl = "/api/projects/5/icon?v=user-row";
    vi.spyOn(api, "listUserIssues").mockResolvedValue(
      page([
        makeItem("todou", 12, {
          project: {
            id: 5,
            slug: "todou",
            name: "Project todou",
            icon_url: iconUrl,
          },
        }),
      ]),
    );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const view = renderAt("/users/alice", clientWithUser());
    const name = await view.findByText("Project todou");
    expect(name.parentElement?.querySelector("img")?.getAttribute("src")).toBe(
      iconUrl,
    );
  });

  it("links each row into its own project, not a page-level one", async () => {
    vi.spyOn(api, "listUserIssues").mockResolvedValue(
      page([makeItem("todou", 12), makeItem("kela", 5)]),
    );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const view = renderAt("/users/alice", clientWithUser());
    const first = await view.findByRole("link", { name: "issue todou 12" });
    expect(first.getAttribute("href")).toBe("/projects/todou/issues/12");
    expect(
      view.getByRole("link", { name: "issue kela 5" }).getAttribute("href"),
    ).toBe("/projects/kela/issues/5");
  });

  it("links spec badges into each row's own project (T-421)", async () => {
    const spec = {
      spec_version: 2,
      spec_review_status: "unreviewed" as const,
    };
    vi.spyOn(api, "listUserIssues").mockResolvedValue(
      page([makeItem("todou", 12, spec), makeItem("kela", 5, spec)]),
    );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const view = renderAt("/users/alice", clientWithUser());
    const links = await view.findAllByRole("link", { name: "spec" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/projects/todou/issues/12/spec",
      "/projects/kela/issues/5/spec",
    ]);
  });

  it("puts the role filter in the URL and refetches under it", async () => {
    const listed = vi
      .spyOn(api, "listUserIssues")
      .mockImplementation(async (_ref, query) =>
        query?.role === "assignee"
          ? page([makeItem("kela", 5)])
          : page([makeItem("todou", 12)]),
      );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const view = renderAt("/users/alice", clientWithUser());
    expect(await view.findByText("T-12")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "Assigned" }));

    await waitFor(() => {
      expect(view.router.state.location.search).toEqual({ role: "assignee" });
    });
    // The address itself, which is what makes a filtered view shareable —
    // and `state` stays out of it, still sitting at its default.
    expect(view.router.state.location.searchStr).toBe("?role=assignee");
    expect(await view.findByText("K-5")).toBeTruthy();
    expect(listed).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ role: "assignee" }),
    );
  });

  it("drops pages appended under the previous filter", async () => {
    // Page 2 of the unfiltered list holds a card that must not survive the
    // switch: an append buffer that is not reset would keep showing it.
    vi.spyOn(api, "listUserIssues").mockImplementation(
      async (_ref, query): Promise<UserIssuesPage> => {
        if (query?.role === "assignee") return page([makeItem("kela", 5)]);
        if (query?.after === "2:cursor") return page([makeItem("todou", 99)]);
        return page([makeItem("todou", 12)], "2:cursor");
      },
    );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const view = renderAt("/users/alice", clientWithUser());
    expect(await view.findByText("T-12")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Load more" }));
    expect(await view.findByText("T-99")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "Assigned" }));
    expect(await view.findByText("K-5")).toBeTruthy();
    await waitFor(() => {
      expect(view.queryByText("T-99")).toBeNull();
    });
  });

  it("appends a page and retires the button at the end of the list", async () => {
    vi.spyOn(api, "listUserIssues").mockImplementation(
      async (_ref, query): Promise<UserIssuesPage> =>
        query?.after === "2:cursor"
          ? page([makeItem("kela", 5)])
          : page([makeItem("todou", 12)], "2:cursor"),
    );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const view = renderAt("/users/alice", clientWithUser());
    expect(await view.findByText("T-12")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Load more" }));
    expect(await view.findByText("K-5")).toBeTruthy();
    // Both pages are on screen at once — appended, not replaced.
    expect(view.getByText("T-12")).toBeTruthy();
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "Load more" })).toBeNull();
    });
  });

  it("offers no Load more when the first page is the whole list", async () => {
    vi.spyOn(api, "listUserIssues").mockResolvedValue(
      page([makeItem("todou", 12)]),
    );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const view = renderAt("/users/alice", clientWithUser());
    expect(await view.findByText("T-12")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps every loaded card when a warm first-page refresh fails with 500", async () => {
    const listIssues = vi
      .spyOn(api, "listUserIssues")
      .mockImplementation(
        async (_ref, query): Promise<UserIssuesPage> =>
          query?.after === "2:cursor"
            ? page([makeItem("kela", 5, { title: "Appended cached card" })])
            : page(
                [makeItem("todou", 12, { title: "First cached card" })],
                "2:cursor",
              ),
      );
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());

    const client = clientWithUser();
    const view = renderAt("/users/alice", client);
    expect(await view.findByText("First cached card")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Load more" }));
    expect(await view.findByText("Appended cached card")).toBeTruthy();
    await waitFor(() => expect(client.isFetching()).toBe(0));

    listIssues.mockRejectedValue(
      Object.assign(new Error("cards refresh failed"), { status: 500 }),
    );
    const firstPage = userIssuesQuery({
      ref: "alice",
      role: "any",
      state: "open",
    });
    await act(async () => {
      await client.refetchQueries({
        queryKey: firstPage.queryKey,
        exact: true,
      });
    });
    await waitFor(() =>
      expect(
        view
          .getByRole("heading", { name: "Ta 的卡" })
          .closest("section")
          ?.querySelector('[role="status"]')?.textContent,
      ).toContain("cards refresh failed"),
    );

    const section = view
      .getByRole("heading", { name: "Ta 的卡" })
      .closest("section");
    expect(section).not.toBeNull();
    const cards = within(section as HTMLElement);
    expectVisible(cards.getByText("First cached card"));
    expectVisible(cards.getByText("Appended cached card"));
    expect(
      await cards.findByText(
        /Couldn't refresh these cards \(cards refresh failed\)/,
      ),
    ).toBeTruthy();
    expect(cards.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("UserProjectsSection (T-374)", () => {
  it("renders a real href per project, with the subject's role", async () => {
    vi.spyOn(api, "listUserIssues").mockResolvedValue(page([]));
    vi.spyOn(api, "listUserProjects").mockResolvedValue({
      items: [
        {
          project: { id: 1, slug: "todou", name: "todou" },
          role: "admin",
          created_at: "2026-05-02T11:03:21.000Z",
        },
        {
          project: { id: 2, slug: "kela", name: "kela" },
          role: "reader",
          created_at: "2026-06-02T11:03:21.000Z",
        },
      ],
    });

    const view = renderAt("/users/alice", clientWithUser());
    const link = await view.findByRole("link", { name: /todou/ });
    // The href is what makes middle-click and ⌘-click work; a handler-only
    // control would satisfy a click assertion and silently drop both.
    expect(link.getAttribute("href")).toBe("/projects/todou");
    expect(view.getByRole("link", { name: /kela/ }).getAttribute("href")).toBe(
      "/projects/kela",
    );
    expect(view.getByText("admin")).toBeTruthy();
    expect(view.getByText("reader")).toBeTruthy();
  });

  it("keeps a project and its role when a warm refresh fails with 500", async () => {
    vi.spyOn(api, "listUserIssues").mockResolvedValue(page([]));
    const listProjects = vi.spyOn(api, "listUserProjects").mockResolvedValue({
      items: [
        {
          project: {
            id: 1,
            slug: "todou",
            name: "Todou Workspace",
          },
          role: "admin",
          created_at: "2026-05-02T11:03:21.000Z",
        },
      ],
    });

    const client = clientWithUser();
    const view = renderAt("/users/alice", client);
    expect(await view.findByText("Todou Workspace")).toBeTruthy();
    await waitFor(() => expect(client.isFetching()).toBe(0));

    listProjects.mockRejectedValue(
      Object.assign(new Error("projects refresh failed"), { status: 500 }),
    );
    const projects = userProjectsQuery("alice");
    await act(async () => {
      await client.refetchQueries({
        queryKey: projects.queryKey,
        exact: true,
      });
    });
    await waitFor(() =>
      expect(
        view
          .getByRole("heading", { name: "Ta 的项目" })
          .closest("section")
          ?.querySelector('[role="status"]')?.textContent,
      ).toContain("projects refresh failed"),
    );

    const section = view
      .getByRole("heading", { name: "Ta 的项目" })
      .closest("section");
    expect(section).not.toBeNull();
    const memberships = within(section as HTMLElement);
    expectVisible(memberships.getByText("Todou Workspace"));
    expectVisible(memberships.getByText("admin"));
    expect(
      await memberships.findByText(
        /Couldn't refresh these projects \(projects refresh failed\)/,
      ),
    ).toBeTruthy();
    expect(memberships.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("User profile section failures (T-420)", () => {
  it("retains both warm sections after 500s and retries only the projects section", async () => {
    const cachedCards = page([
      makeItem("todou", 12, { title: "Saved cross-section card" }),
    ]);
    const cachedProjects: UserProjects = {
      items: [
        {
          project: { id: 1, slug: "todou", name: "Saved Workspace" },
          role: "admin",
          created_at: "2026-05-02T11:03:21.000Z",
        },
      ],
    };
    const recoveredProjects: UserProjects = {
      items: [
        {
          project: { id: 2, slug: "kela", name: "Recovered Workspace" },
          role: "reader",
          created_at: "2026-06-02T11:03:21.000Z",
        },
      ],
    };
    const listIssues = vi
      .spyOn(api, "listUserIssues")
      .mockResolvedValueOnce(cachedCards)
      .mockRejectedValue(
        Object.assign(new Error("cards 500"), { status: 500 }),
      );
    const listProjects = vi
      .spyOn(api, "listUserProjects")
      .mockResolvedValueOnce(cachedProjects)
      .mockRejectedValueOnce(
        Object.assign(new Error("projects 500"), { status: 500 }),
      )
      .mockResolvedValueOnce(recoveredProjects);

    const client = clientWithUser();
    const view = renderAt("/users/alice", client);
    expect(await view.findByText("Saved cross-section card")).toBeTruthy();
    expect(await view.findByText("Saved Workspace")).toBeTruthy();
    await waitFor(() => expect(client.isFetching()).toBe(0));

    const cardsKey = userIssuesQuery({
      ref: "alice",
      role: "any",
      state: "open",
    }).queryKey;
    const projectsKey = userProjectsQuery("alice").queryKey;
    expect(cardsKey).toEqual(["user-issues", "alice", "any", "open"]);
    expect(projectsKey).toEqual(["user-projects", "alice"]);
    await act(async () => {
      await Promise.all([
        client.refetchQueries({ queryKey: cardsKey, exact: true }),
        client.refetchQueries({ queryKey: projectsKey, exact: true }),
      ]);
    });

    const cards = within(
      view
        .getByRole("heading", { name: "Ta 的卡" })
        .closest("section") as HTMLElement,
    );
    const memberships = within(
      view
        .getByRole("heading", { name: "Ta 的项目" })
        .closest("section") as HTMLElement,
    );
    expect(
      await cards.findByText(/Couldn't refresh these cards \(cards 500\)/),
    ).toBeTruthy();
    expect(
      await memberships.findByText(
        /Couldn't refresh these projects \(projects 500\)/,
      ),
    ).toBeTruthy();
    expect(view.getAllByRole("status")).toHaveLength(2);
    expect(cards.getByText("Saved cross-section card")).toBeTruthy();
    expect(memberships.getByText("Saved Workspace")).toBeTruthy();
    expect(memberships.getByText("admin")).toBeTruthy();
    expect(cards.getByRole("button", { name: "Retry" })).toBeTruthy();

    fireEvent.click(memberships.getByRole("button", { name: "Retry" }));
    expect(await memberships.findByText("Recovered Workspace")).toBeTruthy();
    await waitFor(() => expect(memberships.queryByRole("status")).toBeNull());
    expect(memberships.queryByText("Saved Workspace")).toBeNull();
    expect(cards.getByText("Saved cross-section card")).toBeTruthy();
    expect(cards.getByRole("status").textContent).toContain("cards 500");
    expect(client.getQueryData(cardsKey)).toEqual(cachedCards);
    expect(client.getQueryData(projectsKey)).toEqual(recoveredProjects);
    expect(listIssues).toHaveBeenNthCalledWith(1, "alice", {
      role: "any",
      state: "open",
    });
    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(listIssues).toHaveBeenNthCalledWith(2, "alice", {
      role: "any",
      state: "open",
    });
    expect(listProjects).toHaveBeenCalledTimes(3);
    expect(listProjects).toHaveBeenNthCalledWith(1, "alice");
    expect(listProjects).toHaveBeenNthCalledWith(2, "alice");
    expect(listProjects).toHaveBeenNthCalledWith(3, "alice");
  });

  it.each([403, 404])(
    "hides both loaded card pages after a warm %i refusal",
    async (status) => {
      let refused = false;
      const listIssues = vi
        .spyOn(api, "listUserIssues")
        .mockImplementation(async (_ref, query): Promise<UserIssuesPage> => {
          if (query?.after === "2:cursor") {
            return page([
              makeItem("kela", 5, { title: "Appended private card" }),
            ]);
          }
          if (refused) {
            throw Object.assign(new Error(`cards refused ${status}`), {
              status,
            });
          }
          return page(
            [makeItem("todou", 12, { title: "First private card" })],
            "2:cursor",
          );
        });
      vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());
      const client = clientWithUser();
      const view = renderAt("/users/alice", client);
      expect(await view.findByText("First private card")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Load more" }));
      expect(await view.findByText("Appended private card")).toBeTruthy();
      await waitFor(() => expect(client.isFetching()).toBe(0));

      refused = true;
      const cardsKey = userIssuesQuery({
        ref: "alice",
        role: "any",
        state: "open",
      }).queryKey;
      await act(async () => {
        await client.refetchQueries({ queryKey: cardsKey, exact: true });
      });

      const cards = within(
        view
          .getByRole("heading", { name: "Ta 的卡" })
          .closest("section") as HTMLElement,
      );
      expect(
        await cards.findByText(
          `Could not load these cards: cards refused ${status}`,
        ),
      ).toBeTruthy();
      expect(cards.queryByText("First private card")).toBeNull();
      expect(cards.queryByText("Appended private card")).toBeNull();
      expect(cards.queryByText(/Couldn't refresh these cards/)).toBeNull();
      expect(cards.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(
        client.getQueryData<UserIssuesPage>(cardsKey)?.items[0]?.title,
      ).toBe("First private card");
      expect(listIssues).toHaveBeenCalledTimes(3);
      expect(listIssues).toHaveBeenNthCalledWith(2, "alice", {
        role: "any",
        state: "open",
        after: "2:cursor",
      });
      expect(listIssues).toHaveBeenNthCalledWith(3, "alice", {
        role: "any",
        state: "open",
      });
    },
  );

  it("shows empty states with refresh notices after successful empty reads fail", async () => {
    const listIssues = vi
      .spyOn(api, "listUserIssues")
      .mockResolvedValueOnce(page([]))
      .mockRejectedValueOnce(
        Object.assign(new Error("empty cards 500"), { status: 500 }),
      );
    const listProjects = vi
      .spyOn(api, "listUserProjects")
      .mockResolvedValueOnce(noProjects())
      .mockRejectedValueOnce(
        Object.assign(new Error("empty projects 500"), { status: 500 }),
      );
    const client = clientWithUser();
    const view = renderAt("/users/alice", client);
    await view.findByRole("heading", { name: "Ta 的卡" });
    const cards = within(
      view
        .getByRole("heading", { name: "Ta 的卡" })
        .closest("section") as HTMLElement,
    );
    const memberships = within(
      view
        .getByRole("heading", { name: "Ta 的项目" })
        .closest("section") as HTMLElement,
    );
    expect(await cards.findByText("没有你能看到的卡 🥔")).toBeTruthy();
    expect(await memberships.findByText("没有你们都在的项目 🥔")).toBeTruthy();
    await waitFor(() => expect(client.isFetching()).toBe(0));

    const cardsKey = userIssuesQuery({
      ref: "alice",
      role: "any",
      state: "open",
    }).queryKey;
    const projectsKey = userProjectsQuery("alice").queryKey;
    await act(async () => {
      await Promise.all([
        client.refetchQueries({ queryKey: cardsKey, exact: true }),
        client.refetchQueries({ queryKey: projectsKey, exact: true }),
      ]);
    });

    expect(cards.getByText("没有你能看到的卡 🥔")).toBeTruthy();
    expect(memberships.getByText("没有你们都在的项目 🥔")).toBeTruthy();
    expect(
      await cards.findByText(
        /Couldn't refresh these cards \(empty cards 500\)/,
      ),
    ).toBeTruthy();
    expect(
      await memberships.findByText(
        /Couldn't refresh these projects \(empty projects 500\)/,
      ),
    ).toBeTruthy();
    expect(cards.queryByText(/Could not load these cards/)).toBeNull();
    expect(memberships.queryByText(/Could not load these projects/)).toBeNull();
    expect(client.getQueryData(cardsKey)).toEqual(page([]));
    expect(client.getQueryData(projectsKey)).toEqual(noProjects());
    expect(listIssues).toHaveBeenNthCalledWith(2, "alice", {
      role: "any",
      state: "open",
    });
    expect(listProjects).toHaveBeenNthCalledWith(2, "alice");
  });

  it("drops old cards and a cold failure when filters and login change", async () => {
    let resolveBob!: (value: UserIssuesPage) => void;
    const bobCards = new Promise<UserIssuesPage>((resolve) => {
      resolveBob = resolve;
    });
    const listIssues = vi
      .spyOn(api, "listUserIssues")
      .mockImplementation(async (ref, query): Promise<UserIssuesPage> => {
        if (ref === "bob") {
          return bobCards;
        }
        if (query?.role === "assignee") {
          throw Object.assign(new Error("old assigned failure"), {
            status: 500,
          });
        }
        if (query?.role === "author") {
          return page([makeItem("kela", 5, { title: "Created card" })]);
        }
        if (query?.after === "2:cursor") {
          return page([makeItem("todou", 99, { title: "Old appended card" })]);
        }
        return page(
          [makeItem("todou", 12, { title: "Old first card" })],
          "2:cursor",
        );
      });
    const listProjects = vi.spyOn(api, "listUserProjects").mockImplementation(
      async (ref): Promise<UserProjects> => ({
        items: [
          {
            project:
              ref === "alice"
                ? { id: 1, slug: "todou", name: "Alice Workspace" }
                : { id: 2, slug: "kela", name: "Bob Workspace" },
            role: ref === "alice" ? "admin" : "reader",
            created_at: "2026-05-02T11:03:21.000Z",
          },
        ],
      }),
    );
    const client = clientWithUser();
    client.setQueryData(userQuery("bob").queryKey, {
      ...alice,
      id: 8,
      login: "bob",
      display_name: "Bob Potato",
    });
    const view = renderAt("/users/alice", client);
    expect(await view.findByText("Old first card")).toBeTruthy();
    expect(await view.findByText("Alice Workspace")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Load more" }));
    expect(await view.findByText("Old appended card")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "Assigned" }));
    const cards = within(
      view
        .getByRole("heading", { name: "Ta 的卡" })
        .closest("section") as HTMLElement,
    );
    expect(
      await cards.findByText(
        "Could not load these cards: old assigned failure",
      ),
    ).toBeTruthy();
    expect(cards.queryByText("Old first card")).toBeNull();
    expect(cards.queryByText("Old appended card")).toBeNull();
    expect(listIssues).toHaveBeenCalledWith("alice", {
      role: "assignee",
      state: "open",
    });

    fireEvent.click(view.getByRole("tab", { name: "Created" }));
    expect(await cards.findByText("Created card")).toBeTruthy();
    expect(cards.queryByText(/old assigned failure/)).toBeNull();
    expect(cards.queryByText("Old first card")).toBeNull();
    expect(cards.queryByText("Old appended card")).toBeNull();
    expect(listIssues).toHaveBeenCalledWith("alice", {
      role: "author",
      state: "open",
    });

    fireEvent.click(view.getByRole("tab", { name: "Assigned" }));
    expect(
      await cards.findByText(
        "Could not load these cards: old assigned failure",
      ),
    ).toBeTruthy();

    await act(async () => {
      await view.router.navigate({
        to: "/users/$ref",
        params: { ref: "bob" },
        search: { role: "assignee" },
      });
    });
    await waitFor(() =>
      expect(listIssues).toHaveBeenCalledWith("bob", {
        role: "assignee",
        state: "open",
      }),
    );
    expect(view.queryByText("Created card")).toBeNull();
    expect(view.queryByText("Old first card")).toBeNull();
    expect(view.queryByText("Old appended card")).toBeNull();
    expect(view.queryByText(/old assigned failure/)).toBeNull();
    await act(async () => {
      resolveBob(page([makeItem("kela", 8, { title: "Bob card" })]));
      await bobCards;
    });
    expect(await view.findByText("Bob card")).toBeTruthy();
    expect(await view.findByText("Bob Workspace")).toBeTruthy();
    expect(view.queryByText("Alice Workspace")).toBeNull();
    expect(view.queryByText("Created card")).toBeNull();
    expect(view.queryByText("Old first card")).toBeNull();
    expect(view.queryByText("Old appended card")).toBeNull();
    expect(view.queryByText(/old assigned failure/)).toBeNull();
    expect(
      client.getQueryData<UserIssuesPage>(
        userIssuesQuery({ ref: "bob", role: "assignee", state: "open" })
          .queryKey,
      )?.items[0]?.title,
    ).toBe("Bob card");
    expect(listIssues).toHaveBeenCalledWith("bob", {
      role: "assignee",
      state: "open",
    });
    expect(listProjects).toHaveBeenCalledWith("bob");
  });

  it("keeps a cold card failure visible while its Retry is pending", async () => {
    let resolveRetry!: (value: UserIssuesPage) => void;
    const retry = new Promise<UserIssuesPage>((resolve) => {
      resolveRetry = resolve;
    });
    const listIssues = vi
      .spyOn(api, "listUserIssues")
      .mockRejectedValueOnce(
        Object.assign(new Error("cold cards 500"), { status: 500 }),
      )
      .mockImplementationOnce(async () => retry);
    vi.spyOn(api, "listUserProjects").mockResolvedValue(noProjects());
    const view = renderAt("/users/alice", clientWithUser());
    await view.findByRole("heading", { name: "Ta 的卡" });
    const cards = within(
      view
        .getByRole("heading", { name: "Ta 的卡" })
        .closest("section") as HTMLElement,
    );
    expect(
      await cards.findByText("Could not load these cards: cold cards 500"),
    ).toBeTruthy();

    fireEvent.click(cards.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listIssues).toHaveBeenCalledTimes(2));
    expect(
      cards.getByText("Could not load these cards: cold cards 500"),
    ).toBeTruthy();
    expect(
      cards.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(listIssues).toHaveBeenNthCalledWith(2, "alice", {
      role: "any",
      state: "open",
    });

    await act(async () => {
      resolveRetry(
        page([makeItem("todou", 12, { title: "Recovered cold card" })]),
      );
      await retry;
    });
    expect(await cards.findByText("Recovered cold card")).toBeTruthy();
    expect(cards.queryByText(/cold cards 500/)).toBeNull();
  });
});
