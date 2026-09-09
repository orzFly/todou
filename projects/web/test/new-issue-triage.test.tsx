import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  Issue,
  Label,
  Me,
  Member,
  MemberRole,
  Project,
  Status,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { NewIssuePage } from "../src/pages/new-issue.tsx";
import { cmSetValue } from "./cm.ts";
import { testQueryClient } from "./render.tsx";

const SLUG = "todou";

const STATUSES: Status[] = [
  {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 1,
    is_default: true,
  },
  {
    id: 2,
    name: "Done",
    category: "closed",
    color: "#22c55e",
    position: 2,
    is_default: false,
  },
];

const LABELS: Label[] = [{ id: 7, name: "bug", color: "#ef4444" }];

const MEMBERS: Member[] = [
  {
    user: {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    role: "admin",
    created_at: "2026-08-01T00:00:00.000Z",
  },
];

const ME: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-08-01T00:00:00.000Z",
};

/** The new-issue page as seen by someone holding `role` here. */
function renderAs(role: MemberRole) {
  const project: Project = {
    id: 1,
    slug: SLUG,
    name: "todou",
    description: "",
    created_at: "2026-08-01T00:00:00.000Z",
    viewer_role: role,
  };
  const client = testQueryClient();
  client.setQueryData(projectQuery(SLUG).queryKey, project);
  client.setQueryData(statusesQuery(SLUG).queryKey, STATUSES);
  client.setQueryData(labelsQuery(SLUG).queryKey, LABELS);
  client.setQueryData(membersQuery(SLUG).queryKey, MEMBERS);
  client.setQueryData(meQuery.queryKey, ME);

  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const newIssueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/new",
    component: NewIssuePage,
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([newIssueRoute, issueRoute]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/projects/${SLUG}/issues/new`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* biome-ignore lint/suspicious/noExplicitAny: shim route tree */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

const triageControls = () => ({
  status: screen.queryByRole("heading", { name: "Status" }),
  labels: screen.queryByRole("heading", { name: "Labels" }),
  assignees: screen.queryByRole("heading", { name: "Assignees" }),
  editLabels: screen.queryByRole("button", { name: "Edit labels" }),
  editAssignees: screen.queryByRole("button", { name: "Edit assignees" }),
});

describe("the new-issue sidebar", () => {
  it("is hidden from a reporter, who may not set those fields", async () => {
    renderAs("reporter");
    // The form itself must be there — otherwise this asserts nothing.
    await screen.findByLabelText("Title");

    const controls = triageControls();
    expect(controls.status).toBeNull();
    expect(controls.labels).toBeNull();
    expect(controls.assignees).toBeNull();
    expect(controls.editLabels).toBeNull();
    expect(controls.editAssignees).toBeNull();
  });

  it("is shown to a writer", async () => {
    renderAs("writer");
    await screen.findByLabelText("Title");

    await waitFor(() => {
      const controls = triageControls();
      expect(controls.status).not.toBeNull();
      expect(controls.labels).not.toBeNull();
      expect(controls.assignees).not.toBeNull();
      expect(controls.editLabels).not.toBeNull();
      expect(controls.editAssignees).not.toBeNull();
    });
  });

  it("is shown to an admin", async () => {
    renderAs("admin");
    await screen.findByLabelText("Title");
    await waitFor(() => {
      expect(triageControls().status).not.toBeNull();
    });
  });
});

/**
 * Slash commands on the page that opens the card (T-307). Same registry as
 * the composer's, minus the two that need a card to already exist.
 */
describe("the new-issue page's slash commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const created = { id: 1, number: 12, body: "" } as Issue;

  const start = (role: MemberRole) => {
    const createIssue = vi.spyOn(api, "createIssue").mockResolvedValue(created);
    const view = renderAs(role);
    return { view, createIssue };
  };

  const fillTitle = async () => {
    const title = await screen.findByLabelText("Title");
    fireEvent.change(title, { target: { value: "Dig up the potatoes" } });
  };

  const submitButton = () => screen.getByRole("button", { name: /Create|Fix/ });

  it("labels the issue and drops the line from the body", async () => {
    const { view, createIssue } = start("admin");
    await fillTitle();
    cmSetValue(view.container, "the potatoes sprouted\n/label bug");
    await waitFor(() =>
      expect(submitButton().textContent).toBe("Create issue and label bug"),
    );

    submitButton().click();
    await waitFor(() => expect(createIssue).toHaveBeenCalled());
    expect(createIssue.mock.calls[0]?.[1]).toMatchObject({
      title: "Dig up the potatoes",
      body: "the potatoes sprouted",
      label_ids: [7],
    });
  });

  it("counts a label the sidebar already holds only once", async () => {
    const { view, createIssue } = start("admin");
    await fillTitle();
    // The sidebar's own pick, then the same label named in a command.
    (await screen.findByRole("button", { name: "Edit labels" })).click();
    (await screen.findByRole("option", { name: /bug/ })).click();
    // Proven picked, or the command below would be the only source and this
    // would assert nothing about the two agreeing.
    await waitFor(() =>
      expect(
        screen
          .getByRole("option", { name: /bug/ })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    cmSetValue(view.container, "/label bug");
    await waitFor(() =>
      expect(submitButton().textContent).toBe("Create issue and label bug"),
    );

    submitButton().click();
    await waitFor(() => expect(createIssue).toHaveBeenCalled());
    expect(createIssue.mock.calls[0]?.[1]?.label_ids).toEqual([7]);
  });

  it("offers no /hide-all here, so the line stays prose", async () => {
    const { view, createIssue } = start("admin");
    await fillTitle();
    cmSetValue(view.container, "before this\n/hide-all");
    await waitFor(() =>
      expect(submitButton().textContent).toBe("Create issue"),
    );

    submitButton().click();
    await waitFor(() => expect(createIssue).toHaveBeenCalled());
    expect(createIssue.mock.calls[0]?.[1]?.body).toBe("before this\n/hide-all");
  });

  it("blocks the submit when an argument names nothing", async () => {
    const { view, createIssue } = start("admin");
    await fillTitle();
    cmSetValue(view.container, "/label nope");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
    expect(screen.getByRole("alert").textContent).toContain(
      'no label named "nope"',
    );
    expect(submitButton().textContent).toBe("Fix the command");
    submitButton().click();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("does not open the panel for a reporter, who holds none of the fields", async () => {
    const { view, createIssue } = start("reporter");
    await fillTitle();
    cmSetValue(view.container, "please\n/label bug");
    await waitFor(() =>
      expect(submitButton().textContent).toBe("Create issue"),
    );

    submitButton().click();
    await waitFor(() => expect(createIssue).toHaveBeenCalled());
    expect(createIssue.mock.calls[0]?.[1]).toMatchObject({
      body: "please\n/label bug",
      label_ids: [],
    });
  });
});
