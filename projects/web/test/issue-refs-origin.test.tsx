import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
  TimelineComment,
} from "@todou/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import {
  commentLocationQuery,
  issueRefQuery,
  type LocatedComment,
} from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";

const config: ReferenceConfig = {
  format: { prefix: "#", history: [] },
  autolinks: [],
};

const DIRECTORY: ReferenceDirectory = {
  since: "2020-01-01T00:00:00.000Z",
  entries: [],
  contested: [],
};

/** The cross-project grammar (`#comment-N` among it) needs both of these. */
function seedCrossContext(queries: QueryClient): QueryClient {
  queries.setQueryData(referenceDirectoryQuery.queryKey, DIRECTORY);
  queries.setQueryData(
    projectsQuery.queryKey,
    ["a", "b"].map(
      (slug, index): Project => ({
        id: index + 1,
        slug,
        name: slug,
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  return queries;
}

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author: user,
  assignees: [],
  labels: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  moves: [],
});

const comment = (id: number): TimelineComment => ({
  type: "comment",
  id,
  author: user,
  agent_context: null,
  body: "the comment",
  component: null,
  created_at: "2026-01-01T00:00:00.000Z",
  edited_at: null,
  resolved_at: null,
});

function renderWithProviders(ui: ReactElement, client: QueryClient) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectRoute.addChildren([issueRoute]),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/**
 * Text written before the card moved (T-231).
 *
 * Getting this wrong is not a dead link — it is a live one pointing at
 * whatever card happens to hold that number in the project the reader is
 * standing in, which no redirect can undo because that card really exists.
 */
describe("references in text that predates a move", () => {
  it("resolves a bare ref under the project the text was written in", async () => {
    const queries = client();
    queries.setQueryData(referenceConfigQuery("a").queryKey, config);
    queries.setQueryData(referenceConfigQuery("b").queryKey, config);
    // Both projects have a card 12; only A's is the one that was meant.
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));
    queries.setQueryData(issueRefQuery("b", 12).queryKey, refItem(12, "B's"));

    const view = renderWithProviders(
      <MarkdownView slug="b" originSlug="a" refDate="2026-01-01T00:00:00.000Z">
        {"see #12"}
      </MarkdownView>,
      queries,
    );

    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='12']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/a/issues/12");
    expect(link.textContent).toContain("A's");
    // Spelled self-contained: a bare "#12" here would read as B's own.
    expect(link.getAttribute("data-issue-project")).toBe("a");
  });

  it("keeps a bare ref plain when the origin project is unreadable", async () => {
    const queries = client();
    queries.setQueryData(referenceConfigQuery("b").queryKey, config);
    queries.setQueryData(issueRefQuery("b", 12).queryKey, refItem(12, "B's"));

    const view = renderWithProviders(
      <MarkdownView
        slug="b"
        originSlug={null}
        refDate="2026-01-01T00:00:00.000Z"
      >
        {"see #12"}
      </MarkdownView>,
      queries,
    );

    await waitFor(() => expect(view.container.textContent).toContain("#12"));
    expect(view.container.querySelectorAll("a")).toHaveLength(0);
  });

  it("sends a moved #comment-N to the card that now holds it", async () => {
    const queries = seedCrossContext(client());
    queries.setQueryData(referenceConfigQuery("a").queryKey, config);
    queries.setQueryData(referenceConfigQuery("b").queryKey, config);
    // The comment moved to b/45, and a/45 is an unrelated card that exists.
    const located: LocatedComment = {
      slug: "b",
      issue_number: 45,
      issue_ref: "b#45",
      comment: comment(2001),
    };
    queries.setQueryData(commentLocationQuery("a", 1462).queryKey, located);
    queries.setQueryData(
      issueRefQuery("a", 45).queryKey,
      refItem(45, "A's 45"),
    );
    queries.setQueryData(
      issueRefQuery("b", 45).queryKey,
      refItem(45, "Landed"),
    );

    const view = renderWithProviders(
      <MarkdownView slug="a" refDate="2026-01-01T00:00:00.000Z">
        {"see #comment-1462"}
      </MarkdownView>,
      queries,
    );

    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='45']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    // The anchor is the comment's id where it lives now, not where it was.
    expect(link.getAttribute("href")).toBe(
      "/projects/b/issues/45#comment-2001",
    );
    expect(link.getAttribute("data-comment-link")).toBe("2001");
  });
});
