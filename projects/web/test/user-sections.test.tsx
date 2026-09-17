import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type {
  PublicUser,
  UserIssueItem,
  UserIssuesPage,
  UserProjects,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { userQuery, userSearchSchema } from "../src/api/users.ts";
import { UserProfilePage } from "../src/pages/user-profile.tsx";

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
      ProjectRoute.addChildren([IssueRoute]),
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
  return client;
}

const noProjects = (): UserProjects => ({ items: [] });

afterEach(() => {
  vi.restoreAllMocks();
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
});
