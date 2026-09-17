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
  Issue,
  Label,
  Me,
  Member,
  Project,
  Status,
  TimelineComment,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { commentRefQuery } from "../src/api/issue-refs.ts";
import { issueQuery } from "../src/api/issues.ts";
import {
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { NewIssuePage } from "../src/pages/new-issue.tsx";
import { cmGetValue } from "./cm.ts";
import { testQueryClient } from "./render.tsx";

const SLUG = "todou";

const author = {
  id: 2,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const STATUSES: Status[] = [
  {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 1,
    is_default: true,
  },
];
const LABELS: Label[] = [];
const MEMBERS: Member[] = [
  { user: author, role: "admin", created_at: "2026-08-01T00:00:00.000Z" },
];
const ME: Me = {
  ...author,
  email: null,
  is_instance_admin: false,
  created_at: "2026-08-01T00:00:00.000Z",
};

const ISSUE: Issue = {
  id: 11,
  number: 370,
  title: "The card",
  body: "the issue body\n\nwith two paragraphs",
  status: STATUSES[0] as Status,
  author,
  assignees: [],
  labels: [],
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
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
};

const COMMENT: TimelineComment = {
  type: "comment",
  id: 4242,
  author,
  body: "the comment body",
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
};

/** `seed` decides what the quoted content resolves to; leave it out to miss. */
function renderAt(
  search: string,
  seed: (client: ReturnType<typeof testQueryClient>) => void = () => {},
) {
  const project: Project = {
    id: 1,
    slug: SLUG,
    name: "todou",
    description: "",
    created_at: "2026-08-01T00:00:00.000Z",
    viewer_role: "admin",
  };
  const client = testQueryClient();
  client.setQueryData(projectQuery(SLUG).queryKey, project);
  client.setQueryData(statusesQuery(SLUG).queryKey, STATUSES);
  client.setQueryData(labelsQuery(SLUG).queryKey, LABELS);
  client.setQueryData(membersQuery(SLUG).queryKey, MEMBERS);
  client.setQueryData(meQuery.queryKey, ME);
  seed(client);

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
    validateSearch: (raw: Record<string, unknown>) => raw,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectRoute.addChildren([newIssueRoute])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/projects/${SLUG}/issues/new${search}`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* biome-ignore lint/suspicious/noExplicitAny: shim route tree */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

const origin = () => window.location.origin;

describe("a new issue opened to quote something", () => {
  it("prefills the quoted comment and where it came from", async () => {
    const view = renderAt(
      `?quote_project=${SLUG}&quote_issue=370&quote_comment=4242`,
      (client) =>
        client.setQueryData(commentRefQuery(SLUG, 370, 4242).queryKey, COMMENT),
    );
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        [
          "> the comment body",
          "",
          `_Originally posted by @alice in ${origin()}/projects/${SLUG}/issues/370#comment-4242_`,
        ].join("\n"),
      ),
    );
  });

  it("quotes the issue body when no comment is named", async () => {
    const view = renderAt(`?quote_project=${SLUG}&quote_issue=370`, (client) =>
      client.setQueryData(issueQuery(SLUG, 370).queryKey, ISSUE),
    );
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        [
          "> the issue body",
          ">",
          "> with two paragraphs",
          "",
          `_Originally posted by @alice in ${origin()}/projects/${SLUG}/issues/370_`,
        ].join("\n"),
      ),
    );
  });

  it("still renders the form when the quote cannot be read, and says why", async () => {
    const view = renderAt(
      `?quote_project=${SLUG}&quote_issue=370&quote_comment=4242`,
      (client) =>
        client.setQueryData(commentRefQuery(SLUG, 370, 4242).queryKey, null),
    );
    await waitFor(() => expect(view.getByLabelText("Title")).toBeTruthy());
    expect(cmGetValue(view.container)).toBe("");
    expect(view.getByText(/could not be read/, { exact: false })).toBeTruthy();
  });

  it("leaves the editor empty and unexplained without quote params", async () => {
    const view = renderAt("");
    await waitFor(() => expect(view.getByLabelText("Title")).toBeTruthy());
    expect(cmGetValue(view.container)).toBe("");
    expect(view.queryByText(/could not be read/)).toBeNull();
  });
});
