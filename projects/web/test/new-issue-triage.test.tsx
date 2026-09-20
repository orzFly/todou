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
  Attachment,
  Issue,
  Label,
  Me,
  Member,
  MemberRole,
  Project,
  Status,
} from "@todou/shared";
import { toast } from "sonner";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { mutesQuery } from "../src/api/mutes.ts";
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
import { cmGetValue, cmPressKey, cmSetValue } from "./cm.ts";
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
  // The Notifications control reads it for the project-wide mute note; left
  // unseeded it would go to a network this fixture does not have.
  client.setQueryData(mutesQuery.queryKey, { issues: [], projects: [] });

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
  const view = render(
    <QueryClientProvider client={client}>
      {/* biome-ignore lint/suspicious/noExplicitAny: shim route tree */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    setRole: (next: MemberRole) => {
      act(() => {
        client.setQueryData(projectQuery(SLUG).queryKey, {
          ...project,
          viewer_role: next,
        });
      });
    },
  };
}

const triageControls = () => ({
  status: screen.queryByRole("heading", { name: "Status" }),
  labels: screen.queryByRole("heading", { name: "Labels" }),
  assignees: screen.queryByRole("heading", { name: "Assignees" }),
  editLabels: screen.queryByRole("button", { name: "Edit labels" }),
  editAssignees: screen.queryByRole("button", { name: "Edit assignees" }),
});

const sectionsOf = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-sidebar-section]")].map((el) =>
    el.getAttribute("data-sidebar-section"),
  );

describe("the new-issue sidebar", () => {
  it("is hidden from a reporter, who may not set those fields", async () => {
    const view = renderAs("reporter");
    // The form itself must be there — otherwise this asserts nothing.
    await screen.findByLabelText("Title");

    const controls = triageControls();
    expect(controls.status).toBeNull();
    expect(controls.labels).toBeNull();
    expect(controls.assignees).toBeNull();
    expect(controls.editLabels).toBeNull();
    expect(controls.editAssignees).toBeNull();
    // Notifications asks for no capability at all, and it still does not
    // appear: the sidebar it lives in is what a reporter does not get, and
    // that is the whole of what this role's page changed (T-458).
    expect(screen.queryByRole("heading", { name: "Notifications" })).toBeNull();
    expect(sectionsOf(view.container)).toEqual([]);
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

  /**
   * The alignment T-458 asked for, stated as the thing a reader can check:
   * the same sections, under the same names, in the same order as the card
   * page's — which sidebar-order.test.tsx pins from the other end. The two
   * lists are written out separately on purpose; a shared constant would let
   * both move at once and never disagree.
   */
  it("runs the card page's own sections, in the card page's order", async () => {
    const view = renderAs("writer");
    await screen.findByLabelText("Title");
    await waitFor(() => expect(triageControls().status).not.toBeNull());
    expect(sectionsOf(view.container)).toEqual([
      "status",
      "labels",
      "assignees",
      "blocked-by",
      "blocks",
      "notifications",
    ]);
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

/**
 * Edges and a mute picked before the card exists (T-458). Both are replayed
 * onto the number the server hands back, which makes a half-finished submit
 * the case worth pinning: the card is written by then, so pressing Create
 * again has to finish the job rather than file a second one.
 */
describe("the new-issue sidebar's staged edges and mute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const created = { id: 1, number: 12, body: "" } as Issue;

  const fillTitle = async () => {
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Dig up the potatoes" },
    });
  };

  /**
   * Typed rather than picked off the candidate list: this fixture seeds no
   * reference config, so the picker offers only its as-typed row — which is
   * also the row whose ref reaches the server unresolved.
   */
  const stageBlockedBy = async (ref: string) => {
    (
      await screen.findByRole("button", { name: "Add a blocked by entry" })
    ).click();
    const input = await screen.findByPlaceholderText("#12 or other-project#12");
    fireEvent.change(input, { target: { value: ref } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText(ref)).not.toBeNull());
  };

  it("hangs a staged edge on the card it just created", async () => {
    const createIssue = vi.spyOn(api, "createIssue").mockResolvedValue(created);
    const addBlockedBy = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockResolvedValue({ blocked_by: [] });
    renderAs("admin");
    await fillTitle();
    await stageBlockedBy("#404");

    submitButtonFor().click();

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(createIssue).toHaveBeenCalledOnce();
    expect(addBlockedBy).toHaveBeenCalledWith(SLUG, 12, "#404");
  });

  it("keeps the one card when the edge fails, and finishes it on the next press", async () => {
    const createIssue = vi.spyOn(api, "createIssue").mockResolvedValue(created);
    const addBlockedBy = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockRejectedValueOnce(new Error("no such card"))
      .mockResolvedValue({ blocked_by: [] });
    renderAs("admin");
    await fillTitle();
    await stageBlockedBy("#404");

    submitButtonFor().click();
    await waitFor(() => expect(addBlockedBy).toHaveBeenCalledTimes(1));
    // The form is still standing — the card exists, its edge does not, and
    // the button is the only thing that can still close that gap.
    expect(screen.queryByText("the card")).toBeNull();
    expect(createIssue).toHaveBeenCalledOnce();

    submitButtonFor().click();

    expect(await screen.findByText("the card")).toBeTruthy();
    // The whole point of `createdRef`: a second press must not file a second
    // card, only retry what is left.
    expect(createIssue).toHaveBeenCalledOnce();
    expect(addBlockedBy).toHaveBeenCalledTimes(2);
  });

  it("re-sends only the edge that failed", async () => {
    vi.spyOn(api, "createIssue").mockResolvedValue(created);
    const addBlockedBy = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockResolvedValueOnce({ blocked_by: [] })
      .mockRejectedValueOnce(new Error("no such card"))
      .mockResolvedValue({ blocked_by: [] });
    renderAs("admin");
    await fillTitle();
    await stageBlockedBy("#404");
    await stageBlockedBy("#405");

    submitButtonFor().click();
    await waitFor(() => expect(addBlockedBy).toHaveBeenCalledTimes(2));
    // The one that landed is gone from the tray; only the failure is left to
    // look at, and only it goes out again.
    expect(screen.queryByText("#404")).toBeNull();
    expect(screen.queryByText("#405")).not.toBeNull();

    submitButtonFor().click();

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(addBlockedBy.mock.calls.map((call) => call[2])).toEqual([
      "#404",
      "#405",
      "#405",
    ]);
  });

  it("applies a picked mute to the created card", async () => {
    vi.spyOn(api, "createIssue").mockResolvedValue(created);
    const muteIssue = vi.spyOn(api, "muteIssue").mockResolvedValue(undefined);
    renderAs("admin");
    await fillTitle();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Notifying" }),
      { button: 0, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Quiet until unmuted" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Quiet until unmuted" }),
      ).not.toBeNull(),
    );

    submitButtonFor().click();

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(muteIssue).toHaveBeenCalledWith(SLUG, 12, { mode: "forever" });
  });

  it("sends no mute when the pick is left where it starts", async () => {
    vi.spyOn(api, "createIssue").mockResolvedValue(created);
    const muteIssue = vi.spyOn(api, "muteIssue").mockResolvedValue(undefined);
    renderAs("admin");
    await fillTitle();

    submitButtonFor().click();

    expect(await screen.findByText("the card")).toBeTruthy();
    // Notifying is what a card with no mute row already does; writing one
    // saying so would be a row the reader never asked for.
    expect(muteIssue).not.toHaveBeenCalled();
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

    // The echo lives in the Assignees section, under the heading row that
    // carries the picker. It restates a choice the reader just made on a card
    // that does not exist yet, so it is a readout, not a way to anybody's
    // page.
    const heading = await screen.findByRole("heading", { name: "Assignees" });
    const echo = (heading.closest("[data-sidebar-section]") as HTMLElement)
      .children[1] as HTMLElement;
    expect(echo.querySelectorAll('a[href^="/users/"]')).toHaveLength(0);
    // The other half: an echo that rendered nothing would pass the line above.
    expect(echo.textContent).toContain("User");
  });
});

// These helpers use the rendered pickers, so the navigation cases exercise
// the same state changes as a reader with an otherwise empty form.
async function pickStatus(name: "Todo" | "Done") {
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(screen.getByRole("combobox").textContent).toContain(name);
}

async function toggleBug() {
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
  fireEvent.click(await screen.findByRole("option", { name: /bug/ }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "filter labels" }), {
    key: "Escape",
  });
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "filter labels" })).toBeNull(),
  );
}

async function toggleUser() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Edit assignees" }),
    {
      button: 0,
      pointerType: "mouse",
    },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: /User/ }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

async function pickNotifications(quiet: boolean) {
  fireEvent.pointerDown(
    screen.getByRole("button", {
      name: quiet ? "Notifying" : "Quiet until unmuted",
    }),
    { button: 0, pointerType: "mouse" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: quiet ? "Quiet until unmuted" : "Notify on new activity",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

async function stageEdge(direction: "blocked by" | "blocks", ref: string) {
  fireEvent.click(
    screen.getByRole("button", { name: `Add a ${direction} entry` }),
  );
  // As in the T-458 cases, no reference config is seeded: Enter chooses the
  // as-typed reference rather than fetching an issue candidate.
  const input = await screen.findByPlaceholderText("#12 or other-project#12");
  fireEvent.change(input, { target: { value: ref } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByText(ref)).not.toBeNull());
}

function sidebarText(name: string) {
  return screen.getByRole("heading", { name }).closest("[data-sidebar-section]")
    ?.textContent;
}

async function stageNotes(container: HTMLElement) {
  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("missing attachment input");
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByRole("button", { name: "remove notes.txt" });
  return file;
}

describe("the new-issue page's edited retries (T-477)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const original: Issue = {
    id: 1,
    number: 12,
    title: "Teh potatos",
    body: "",
    status: STATUSES[0] as Status,
    author: ME,
    assignees: [],
    labels: [],
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
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
  };
  const attachment: Attachment = {
    id: 20,
    filename: "notes.txt",
    content_type: "text/plain",
    size: 5,
    url: "/attachments/notes.txt",
    uploader: ME,
    created_at: original.created_at,
    aliases: [],
  };
  const marker = "[notes.txt](/attachments/notes.txt)";

  const start = (serverIssue = original) => {
    // Return fresh server snapshots reflecting writes. Returning the same
    // incomplete Issue for every PATCH would hide a stale retry baseline.
    let stored = serverIssue;
    const apply = (fields: Parameters<typeof api.updateIssue>[2]) => {
      stored = {
        ...stored,
        title: fields.title ?? stored.title,
        body: fields.body ?? stored.body,
        status:
          STATUSES.find((status) => status.id === fields.status_id) ??
          stored.status,
        labels:
          fields.label_ids === undefined
            ? stored.labels
            : LABELS.filter((label) => fields.label_ids?.includes(label.id)),
        assignees:
          fields.assignee_ids === undefined
            ? stored.assignees
            : MEMBERS.filter((member) =>
                fields.assignee_ids?.includes(member.user.id),
              ).map((member) => member.user),
      };
      return stored;
    };
    const createIssue = vi
      .spyOn(api, "createIssue")
      .mockImplementation(async (_slug, fields) => apply(fields));
    const updateIssue = vi
      .spyOn(api, "updateIssue")
      .mockImplementation(async (_slug, _number, fields) => apply(fields));
    const addBlockedBy = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockRejectedValueOnce(new Error("edge unavailable"))
      .mockResolvedValue({ blocked_by: [] });
    const error = vi.spyOn(toast, "error").mockReturnValue("retry-error");
    return {
      view: renderAs("admin"),
      createIssue,
      updateIssue,
      addBlockedBy,
      error,
    };
  };

  const prepare = async () => {
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Teh potatos" },
    });
    await stageEdge("blocked by", "#404");
  };

  const submit = () => {
    fireEvent.click(submitButtonFor());
  };

  const expectFailure = async (
    error: MockInstance<typeof toast.error>,
    message: string,
  ) => {
    await waitFor(() =>
      expect(error).toHaveBeenLastCalledWith(
        message.startsWith("edge ") ? `#404: ${message}` : message,
      ),
    );
    await waitFor(() =>
      expect((submitButtonFor() as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByText("the card")).toBeNull();
    expect(screen.getByLabelText("Title")).toBeTruthy();
  };

  const editFields = async (container: HTMLElement) => {
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "The potatoes" },
    });
    cmSetValue(container, "They have sprouted.");
    await pickStatus("Done");
    await toggleBug();
    await toggleUser();
  };

  const changes = {
    title: "The potatoes",
    body: "They have sprouted.",
    status_id: 2,
    label_ids: [7],
    assignee_ids: [1],
  };

  it("omits triage after a downgrade and preserves its saved baseline until permission returns", async () => {
    const { view, createIssue, updateIssue, error } = start();
    const upload = vi
      .spyOn(api, "uploadAttachment")
      .mockRejectedValueOnce(new Error("upload unavailable"))
      .mockResolvedValue(attachment);
    const mute = vi
      .spyOn(api, "muteIssue")
      .mockRejectedValueOnce(new Error("mute unavailable"))
      .mockResolvedValue(undefined);
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Teh potatos" },
    });
    await pickStatus("Done");
    await toggleBug();
    await toggleUser();
    await pickNotifications(true);
    await stageNotes(view.container);
    submit();
    await expectFailure(error, "notes.txt: upload unavailable");
    expect(createIssue).toHaveBeenCalledExactlyOnceWith(SLUG, {
      title: "Teh potatos",
      body: "",
      status_id: 2,
      label_ids: [7],
      assignee_ids: [1],
    });

    // These edits remain unsent while the triage controls are hidden.
    await pickStatus("Todo");
    await toggleBug();
    await toggleUser();
    view.setRole("reporter");
    await waitFor(() => expect(triageControls().status).toBeNull());
    expect(triageControls().editLabels).toBeNull();
    expect(triageControls().editAssignees).toBeNull();
    submit();
    // The body succeeds; a later, independent failure keeps the form here
    // so restoring permission can exercise the saved triage checkpoint.
    await expectFailure(error, "mute unavailable");
    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(SLUG, 12, {
      body: marker,
    });

    view.setRole("admin");
    await screen.findByRole("heading", { name: "Status" });
    submit();
    expect(await screen.findByText("the card")).toBeTruthy();
    expect(updateIssue.mock.calls).toEqual([
      [SLUG, 12, { body: marker }],
      [SLUG, 12, { status_id: 1, label_ids: [], assignee_ids: [] }],
    ]);
    expect(createIssue).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(mute).toHaveBeenCalledTimes(2);
  });

  it("keeps the server's implicit default through retries when the cached default is stale", async () => {
    const { createIssue, updateIssue, error } = start({
      ...original,
      status: STATUSES[1] as Status,
    });
    await prepare();
    submit();
    await expectFailure(error, "edge unavailable");
    expect(sidebarText("Status")).toContain("Done");
    expect(updateIssue).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "The potatoes" },
    });
    submit();
    expect(await screen.findByText("the card")).toBeTruthy();
    expect(createIssue).toHaveBeenCalledOnce();
    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(SLUG, 12, {
      title: "The potatoes",
    });
  });

  it("restores default status after removing /status Done and clears saved labels and assignees on retry", async () => {
    const { view, createIssue, updateIssue, addBlockedBy, error } = start();
    await prepare();
    cmSetValue(view.container, "/status Done");
    await toggleBug();
    await toggleUser();
    submit();
    await expectFailure(error, "edge unavailable");
    expect(createIssue).toHaveBeenCalledExactlyOnceWith(SLUG, {
      title: "Teh potatos",
      body: "",
      status_id: 2,
      label_ids: [7],
      assignee_ids: [1],
    });

    cmSetValue(view.container, "");
    await toggleBug();
    await toggleUser();
    expect(sidebarText("Status")).toContain("Todo");
    expect(sidebarText("Labels")).not.toContain("bug");
    expect(sidebarText("Assignees")).not.toContain("User");
    submit();

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(SLUG, 12, {
      status_id: 1,
      label_ids: [],
      assignee_ids: [],
    });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(addBlockedBy).toHaveBeenCalledTimes(2);
  });

  it("patches the corrected title, body and triage before retrying the failed edge", async () => {
    const { view, createIssue, updateIssue, addBlockedBy, error } = start();
    await prepare();
    submit();
    await expectFailure(error, "edge unavailable");
    expect(createIssue).toHaveBeenCalledWith(
      SLUG,
      expect.objectContaining({ title: "Teh potatos", body: "" }),
    );
    expect(updateIssue).not.toHaveBeenCalled();

    await editFields(view.container);
    submit();

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(createIssue).toHaveBeenCalledOnce();
    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(SLUG, 12, changes);
    expect(addBlockedBy).toHaveBeenCalledTimes(2);
    expect(updateIssue.mock.invocationCallOrder[0]).toBeLessThan(
      addBlockedBy.mock.invocationCallOrder[1] as number,
    );
    expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();
  });

  it("keeps edited fields after a failed PATCH and retries no edge until the PATCH succeeds", async () => {
    const { view, createIssue, updateIssue, addBlockedBy, error } = start();
    updateIssue.mockRejectedValueOnce(new Error("update unavailable"));
    await prepare();
    submit();
    await expectFailure(error, "edge unavailable");
    await editFields(view.container);
    submit();
    await expectFailure(error, "update unavailable");

    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(SLUG, 12, changes);
    expect(addBlockedBy).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "The potatoes",
    );
    expect(cmGetValue(view.container)).toBe(changes.body);
    expect(sidebarText("Status")).toContain("Done");
    expect(sidebarText("Labels")).toContain("bug");
    expect(sidebarText("Assignees")).toContain("User");
    expect(screen.getByText("#404")).toBeTruthy();

    submit();
    expect(await screen.findByText("the card")).toBeTruthy();
    expect(createIssue).toHaveBeenCalledOnce();
    expect(updateIssue.mock.calls).toEqual([
      [SLUG, 12, changes],
      [SLUG, 12, changes],
    ]);
    expect(addBlockedBy).toHaveBeenCalledTimes(2);
    expect(updateIssue.mock.invocationCallOrder[1]).toBeLessThan(
      addBlockedBy.mock.invocationCallOrder[1] as number,
    );
  });

  it("retries an unchanged form without a PATCH", async () => {
    const { createIssue, updateIssue, addBlockedBy, error } = start();
    await prepare();
    submit();
    await expectFailure(error, "edge unavailable");
    submit();

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(createIssue).toHaveBeenCalledOnce();
    expect(updateIssue).not.toHaveBeenCalled();
    expect(addBlockedBy.mock.calls).toEqual([
      [SLUG, 12, "#404"],
      [SLUG, 12, "#404"],
    ]);
  });

  it("preserves uploaded attachment markers when the body changes after an edge failure", async () => {
    const { view, createIssue, updateIssue, addBlockedBy, error } = start();
    const upload = vi
      .spyOn(api, "uploadAttachment")
      .mockResolvedValue(attachment);
    await prepare();
    cmSetValue(view.container, "Before the retry.");
    const file = await stageNotes(view.container);
    submit();
    await expectFailure(error, "edge unavailable");
    expect(updateIssue).toHaveBeenCalledExactlyOnceWith(SLUG, 12, {
      body: `Before the retry.\n\n${marker}`,
    });

    cmSetValue(view.container, "After the retry.");
    submit();
    expect(await screen.findByText("the card")).toBeTruthy();
    expect(updateIssue.mock.calls).toEqual([
      [SLUG, 12, { body: `Before the retry.\n\n${marker}` }],
      [SLUG, 12, { body: `After the retry.\n\n${marker}` }],
    ]);
    expect(upload).toHaveBeenCalledExactlyOnceWith(SLUG, 12, file);
    expect(createIssue).toHaveBeenCalledOnce();
    expect(addBlockedBy).toHaveBeenCalledTimes(2);
  });

  it.each(["edited fields", "uploaded attachment"] as const)(
    "does not resend a successful PATCH after another edge failure: %s",
    async (kind) => {
      const { view, createIssue, updateIssue, addBlockedBy, error } = start();
      const upload = vi
        .spyOn(api, "uploadAttachment")
        .mockResolvedValue(attachment);
      await prepare();
      if (kind === "uploaded attachment") {
        await stageNotes(view.container);
      } else {
        submit();
        await expectFailure(error, "edge unavailable");
        await editFields(view.container);
        addBlockedBy.mockRejectedValueOnce(new Error("edge still unavailable"));
      }

      submit();
      await expectFailure(
        error,
        kind === "uploaded attachment"
          ? "edge unavailable"
          : "edge still unavailable",
      );
      expect(updateIssue).toHaveBeenCalledExactlyOnceWith(
        SLUG,
        12,
        kind === "uploaded attachment" ? { body: marker } : changes,
      );
      submit();

      expect(await screen.findByText("the card")).toBeTruthy();
      expect(updateIssue).toHaveBeenCalledOnce();
      expect(createIssue).toHaveBeenCalledOnce();
      expect(addBlockedBy).toHaveBeenCalledTimes(
        kind === "uploaded attachment" ? 2 : 3,
      );
      expect(upload).toHaveBeenCalledTimes(
        kind === "uploaded attachment" ? 1 : 0,
      );
    },
  );
});

describe("the new-issue page's sidebar-only navigation guard (T-478)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const choices = [
    {
      name: "Status",
      pick: () => pickStatus("Done"),
      undo: () => pickStatus("Todo"),
      selected: () => expect(sidebarText("Status")).toContain("Done"),
      cleared: () => expect(sidebarText("Status")).toContain("Todo"),
    },
    {
      name: "Labels",
      pick: toggleBug,
      undo: toggleBug,
      selected: () => expect(sidebarText("Labels")).toContain("bug"),
      cleared: () => expect(sidebarText("Labels")).not.toContain("bug"),
    },
    {
      name: "Assignees",
      pick: toggleUser,
      undo: toggleUser,
      selected: () => expect(sidebarText("Assignees")).toContain("User"),
      cleared: () => expect(sidebarText("Assignees")).not.toContain("User"),
    },
    {
      name: "Blocked by",
      pick: () => stageEdge("blocked by", "#404"),
      undo: () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Remove this blocked by entry" }),
        ),
      selected: () => expect(sidebarText("Blocked by")).toContain("#404"),
      cleared: () => expect(sidebarText("Blocked by")).not.toContain("#404"),
    },
    {
      name: "Blocks",
      pick: () => stageEdge("blocks", "#405"),
      undo: () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Remove this blocks entry" }),
        ),
      selected: () => expect(sidebarText("Blocks")).toContain("#405"),
      cleared: () => expect(sidebarText("Blocks")).not.toContain("#405"),
    },
    {
      name: "Notifications",
      pick: () => pickNotifications(true),
      undo: () => pickNotifications(false),
      selected: () =>
        expect(sidebarText("Notifications")).toContain("Quiet until unmuted"),
      cleared: () =>
        expect(sidebarText("Notifications")).toContain("Notifying"),
    },
  ];

  const expectEmptyText = (container: HTMLElement) => {
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect(cmGetValue(container)).toBe("");
  };

  const cancelAndKeepEditing = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("dialog", {
        name: "Leave with unsaved changes?",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("the project")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("Title")).toBeTruthy();
    expect(screen.queryByText("the project")).toBeNull();
  };

  const cancelCleanly = async (container: HTMLElement) => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("the project")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  };

  it.each(choices)(
    "guards Cancel for $name alone, preserves it on Keep editing, and becomes clean after undo",
    async (choice) => {
      const view = renderAs("admin");
      await screen.findByLabelText("Title");
      await choice.pick();
      choice.selected();
      expectEmptyText(view.container);

      await cancelAndKeepEditing();
      choice.selected();
      expectEmptyText(view.container);

      await choice.undo();
      choice.cleared();
      expectEmptyText(view.container);
      await cancelCleanly(view.container);
    },
  );

  it("lets Cancel leave an empty pristine form without a dialog", async () => {
    const view = renderAs("admin");
    await screen.findByLabelText("Title");
    expectEmptyText(view.container);
    await cancelCleanly(view.container);
  });

  it("keeps an attachment-only draft on Keep editing and becomes clean after removal", async () => {
    const upload = vi.spyOn(api, "uploadAttachment");
    const view = renderAs("admin");
    await screen.findByLabelText("Title");
    await stageNotes(view.container);
    expectEmptyText(view.container);

    await cancelAndKeepEditing();
    expect(
      screen.getByRole("button", { name: "remove notes.txt" }),
    ).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expectEmptyText(view.container);
    expect(upload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "remove notes.txt" }));
    expect(screen.queryByText("notes.txt")).toBeNull();
    await cancelCleanly(view.container);
    expect(upload).not.toHaveBeenCalled();
  });

  it("lands on the created card with all six sidebar choices without a discard dialog", async () => {
    const createIssue = vi
      .spyOn(api, "createIssue")
      .mockResolvedValue({ id: 1, number: 12, body: "" } as Issue);
    const blockedBy = vi
      .spyOn(api, "addIssueBlockedBy")
      .mockResolvedValue({ blocked_by: [] });
    const blocks = vi
      .spyOn(api, "addIssueBlocks")
      .mockResolvedValue({ blocks: [] });
    const mute = vi.spyOn(api, "muteIssue").mockResolvedValue(undefined);
    const view = renderAs("admin");
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "The potatoes" },
    });
    for (const choice of choices) {
      await choice.pick();
      choice.selected();
    }
    fireEvent.click(submitButtonFor());

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(createIssue).toHaveBeenCalledExactlyOnceWith(SLUG, {
      title: "The potatoes",
      body: "",
      status_id: 2,
      label_ids: [7],
      assignee_ids: [1],
    });
    expect(blockedBy).toHaveBeenCalledExactlyOnceWith(SLUG, 12, "#404");
    expect(blocks).toHaveBeenCalledExactlyOnceWith(SLUG, 12, "#405");
    expect(mute).toHaveBeenCalledExactlyOnceWith(SLUG, 12, { mode: "forever" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.container.querySelector("form")).toBeNull();
  });
});
