import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { UnsavedChangesGuard } from "../src/components/shared/unsaved-guard.tsx";
import { NewIssuePage } from "../src/pages/new-issue.tsx";
import { cmPressKey, cmSetValue } from "./cm.ts";
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

  // The guard rather than `AppShell`, whose only contribution to leaving is to
  // render this: the shell would also open the user-level stream, fetch the
  // auth mode and put a Suspense boundary around the page, none of which the
  // navigation reads and each of which is another way for these tests to fail
  // for reasons that are not theirs.
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <UnsavedChangesGuard />
        <Outlet />
      </>
    ),
  });
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const projectIndexRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    component: () => <div>the project</div>,
  });
  const newIssueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/new",
    component: NewIssuePage,
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>the card</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([
          projectIndexRoute,
          newIssueRoute,
          issueRoute,
        ]),
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

/**
 * The guard must not stop the navigation that follows a successful creation
 * (T-317). The predicates read the title and the body, and nothing resets
 * them before the `navigate()` call — so without `ignoreBlocker` the page
 * that just committed the issue asks the reader whether to discard it, and
 * "Keep editing" strands them on a form whose Create button will not post
 * again (`createdRef`).
 */
describe("the guard after a created issue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const created = { id: 1, number: 12, body: "" } as Issue;

  const start = () => {
    const createIssue = vi.spyOn(api, "createIssue").mockResolvedValue(created);
    return { createIssue, view: renderAs("admin") };
  };

  it("lands on the new card instead of asking to discard it", async () => {
    const { view, createIssue } = start();
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Dig up the potatoes" },
    });

    submitButtonFor().click();
    await waitFor(() => expect(createIssue).toHaveBeenCalledOnce());

    // Arrival is the assertion that fails when the guard stops this: a blocked
    // navigation leaves the form standing and the card unreached.
    expect(await screen.findByText("the card")).toBeTruthy();
    expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();
    expect(view.container.querySelector("form")).toBeNull();
  });

  /**
   * The other half of the test above: it asserts an absence, which is only
   * worth anything while the guard really is in this tree. Cancel is the
   * control on this page that navigates without `ignoreBlocker` (T-317), so
   * one confirmation here proves the fixture can produce one at all.
   */
  it("still asks when Cancel drops the same unsaved form", async () => {
    start();
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Dig up the potatoes" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("Leave with unsaved changes?")).toBeTruthy();
    expect(screen.queryByText("the project")).toBeNull();
  });
});

const submitButtonFor = () =>
  screen.getByRole("button", { name: /Create|Fix/ });

describe("the new-issue page's Ctrl-Enter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const created = { id: 1, number: 12, body: "" } as Issue;

  const start = () => {
    const createIssue = vi.spyOn(api, "createIssue").mockResolvedValue(created);
    return { view: renderAs("admin"), createIssue };
  };

  it("creates the issue from the description box", async () => {
    const { view, createIssue } = start();
    const title = await screen.findByLabelText("Title");
    fireEvent.change(title, { target: { value: "Dig up the potatoes" } });
    cmSetValue(view.container, "the potatoes sprouted");
    cmPressKey(view.container, "Enter", { ctrlKey: true });

    await waitFor(() => expect(createIssue).toHaveBeenCalledOnce());
    expect(createIssue.mock.calls[0]?.[1]).toMatchObject({
      title: "Dig up the potatoes",
      body: "the potatoes sprouted",
    });
  });

  it("creates nothing when the title is empty", async () => {
    const { view, createIssue } = start();
    await screen.findByLabelText("Title");
    cmSetValue(view.container, "a body with no title");
    cmPressKey(view.container, "Enter", { ctrlKey: true });

    await act(async () => {});
    expect(createIssue).not.toHaveBeenCalled();
  });
});

describe("the new-issue sidebar's picked assignees (T-391)", () => {
  it("echoes the pick without linking it — there is no card yet", async () => {
    renderAs("admin");
    await screen.findByLabelText("Title");

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Edit assignees" }),
      { button: 0, pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /User/ }));
    // The picker stays open on purpose (several people in a row), and while
    // it is open Radix marks the rest of the page `aria-hidden`, which hides
    // the very section this case is about from every role query.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // The echo lives under the Assignees heading, beside the picker that
    // wrote it. It restates a choice the reader just made on a card that does
    // not exist yet, so it is a readout, not a way to anybody's page.
    const echo = (await screen.findByRole("heading", { name: "Assignees" }))
      .nextElementSibling as HTMLElement;
    expect(echo.querySelectorAll('a[href^="/users/"]')).toHaveLength(0);
    // The other half: an echo that rendered nothing would pass the line above.
    expect(echo.textContent).toContain("User");
  });
});
