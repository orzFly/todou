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
} from "@todou/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { issueRefQuery, type ResolvedIssueRef } from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";

const config: ReferenceConfig = {
  format: { prefix: null, history: [] },
  autolinks: [],
};

const DIRECTORY: ReferenceDirectory = { entries: [], contested: [] };

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

/** Projects 1 and 2 are readable; 9 is not in the viewer's directory. */
function seed(queries: QueryClient): QueryClient {
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
  queries.setQueryData(referenceConfigQuery("a").queryKey, config);
  queries.setQueryData(referenceConfigQuery("b").queryKey, config);
  return queries;
}

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

const anchor = async (
  view: ReturnType<typeof render>,
  number: number,
): Promise<HTMLAnchorElement> =>
  waitFor(() => {
    const el = view.container.querySelector(`a[data-issue-link='${number}']`);
    expect(el).not.toBeNull();
    return el as HTMLAnchorElement;
  });

/**
 * How a stored reference renders (T-266). The document holds an explicit
 * link onto a project id; the reader turns that id back into the slug it
 * answers to today and decorates the link with the card behind it.
 */
describe("stored id-anchored references", () => {
  it("decorates an id link and points it at the project's current slug", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [#12](/projects/1/issues/12)"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/a/issues/12");
    expect(link.textContent).toContain("A's");
  });

  it("spells a link into another project self-containedly", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("b", 12).queryKey, refItem(12, "B's"));

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [b#12](/projects/2/issues/12)"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/b/issues/12");
    expect(link.getAttribute("data-issue-project")).toBe("b");
  });

  it("leaves a link into a project the reader cannot name alone", async () => {
    const queries = seed(client());

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [#12](/projects/9/issues/12)"}
      </MarkdownView>,
      queries,
    );

    await waitFor(() => expect(view.container.textContent).toContain("#12"));
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/projects/9/issues/12");
    expect(link?.getAttribute("data-issue-link")).toBeNull();
  });

  it("points at the card's current address, so a click spends no redirect", async () => {
    const queries = seed(client());
    const moved: ResolvedIssueRef = {
      ...refItem(45, "Landed"),
      at: { slug: "b", number: 45 },
    };
    queries.setQueryData(issueRefQuery("a", 12).queryKey, moved);

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [#12](/projects/1/issues/12)"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/b/issues/45");
  });

  it("carries a comment anchor into the link", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [#12#comment-7](/projects/1/issues/12#comment-7)"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/a/issues/12#comment-7");
    expect(link.getAttribute("data-comment-link")).toBe("7");
  });
});

/**
 * What reading mode does with a bare token. Nothing: a token still sitting
 * in stored text is one the resolve pass could not place, and drawing it as
 * a link would put the guess back that T-266 removes.
 */
describe("bare tokens in stored text", () => {
  it("renders a bare ref as plain text", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));

    const view = renderWithProviders(
      <MarkdownView slug="a">{"see #12"}</MarkdownView>,
      queries,
    );

    await waitFor(() =>
      expect(view.container.textContent).toContain("see #12"),
    );
    expect(view.container.querySelectorAll("a")).toHaveLength(0);
  });

  it("still expands an external autolink", async () => {
    const queries = seed(client());
    queries.setQueryData(referenceConfigQuery("a").queryKey, {
      format: { prefix: null, history: [] },
      autolinks: [
        {
          id: 1,
          prefix: "JIRA-",
          url_template: "https://tracker.example/<num>",
        },
      ],
    } satisfies ReferenceConfig);

    const view = renderWithProviders(
      <MarkdownView slug="a">{"fixes JIRA-42"}</MarkdownView>,
      queries,
    );

    const link = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("https://tracker.example/42");
    expect(link.textContent).toBe("JIRA-42");
  });

  it("highlights a bare ref in an editor preview", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));

    const view = renderWithProviders(
      <MarkdownView slug="a" preview>
        {"see #12"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/a/issues/12");
  });
});
