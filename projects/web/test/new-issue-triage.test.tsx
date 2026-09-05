import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import type { Label, Member, MemberRole, Project, Status } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  labelsQuery,
  membersQuery,
  projectQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { NewIssuePage } from "../src/pages/new-issue.tsx";
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

  const rootRoute = createRootRoute();
  const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "authed" });
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
