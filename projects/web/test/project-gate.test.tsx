import { QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@todou/shared";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueQuery } from "../src/api/issues.ts";
import {
  labelsQuery,
  membersQuery,
  meQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { IssueRouteError } from "../src/pages/issue-route-error.tsx";
import {
  ProjectLayout,
  ProjectRouteError,
} from "../src/pages/project-layout.tsx";
import { testQueryClient } from "./render.tsx";

const ME = { id: 1, login: "bot-one", name: "Bot One" };

const PROJECT_A: Project = {
  id: 1,
  slug: "a",
  name: "a",
  description: "",
  created_at: "2026-08-01T00:00:00.000Z",
  former_slugs: [],
};

const PROJECT_B: Project = {
  id: 2,
  slug: "b",
  name: "b",
  description: "",
  created_at: "2026-08-01T00:00:00.000Z",
  former_slugs: [],
};

// Only the title is read back, so the card body stays at the one field the
// stand-in renders.
const ISSUE_B2 = { number: 2, title: "The card, at its new address" };

const PROJECT_MISS_TEXT =
  "This project does not exist, or you do not have access to it.";
/** Marks the boundary the project layer rethrows to. */
const ABOVE = "handled above the project layer";

type Reply = [status: number, body: unknown];

const NOT_FOUND: Reply = [
  404,
  { error: { code: "not_found", message: "not found" } },
];

/** Records every request URL and answers from `table`; the rest 404s. */
function stubFetch(table: Record<string, Reply>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const [status, body] = table[url] ?? NOT_FOUND;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

/**
 * Stands in for IssueDetailPage. The query order is copied from
 * issue-detail.tsx:86-91 and is itself part of what these tests cover:
 * issueQuery has to reach its redirect before the project-scoped queries
 * below it are opened.
 */
function IssueStubBody() {
  const { slug, number } = useParams({
    from: "/authed/projects/$slug/issues/$number",
  });
  useSuspenseQuery(meQuery);
  const issue = useSuspenseQuery(issueQuery(slug, Number(number)));
  useSuspenseQuery(statusesQuery(slug));
  useSuspenseQuery(labelsQuery(slug));
  useSuspenseQuery(membersQuery(slug));
  return <div>{issue.data.title}</div>;
}

function IssueStub() {
  return (
    <Suspense fallback={<div>loading</div>}>
      <IssueStubBody />
    </Suspense>
  );
}

/**
 * The real layout and both real error boundaries over the stand-in. The
 * pathless "authed" id has to be here: ProjectLayout and IssueRouteError
 * both read their params from "/authed/projects/$slug".
 */
function renderAt(url: string) {
  const client = testQueryClient();
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    errorComponent: () => <div>{ABOVE}</div>,
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: ProjectLayout,
    errorComponent: ProjectRouteError,
  });
  const projectIndexRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    component: () => <div>project index</div>,
  });
  const issuesRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: IssueStub,
    errorComponent: IssueRouteError,
    staticData: { resolvesProjectMiss: true },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([projectIndexRoute, issuesRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project gate", () => {
  it("follows a moved card whose old project the reader cannot read", async () => {
    const calls = stubFetch({
      "/api/me": [200, ME],
      "/api/projects/a": NOT_FOUND,
      "/api/projects/a/issues/1": [301, { moved_to: { slug: "b", number: 2 } }],
      "/api/projects/b": [200, PROJECT_B],
      "/api/projects/b/issues/2": [200, ISSUE_B2],
      "/api/projects/b/statuses": [200, []],
      "/api/projects/b/labels": [200, []],
      "/api/projects/b/members": [200, []],
    });
    const router = renderAt("/projects/a/issues/1");

    expect(await screen.findByText(ISSUE_B2.title)).toBeTruthy();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/b/issues/2"),
    );

    // The redirect only wins the boundary because the suspense queries run
    // one after another. Prefetching them concurrently would put three 404s
    // from project a in flight beside the redirect, and this line is where
    // that shows up first.
    expect(
      calls.filter((url) =>
        /^\/api\/projects\/a\/(statuses|labels|members)$/.test(url),
      ),
    ).toEqual([]);
  });

  it("keeps answering for a project miss with no card in the URL", async () => {
    const calls = stubFetch({
      "/api/me": [200, ME],
      "/api/projects/a": NOT_FOUND,
    });
    renderAt("/projects/a");

    expect(await screen.findByText(PROJECT_MISS_TEXT)).toBeTruthy();
    expect(calls.filter((url) => url.includes("/issues"))).toEqual([]);
  });

  it("sends a project failure that is not a 404 to the boundary above", async () => {
    stubFetch({
      "/api/me": [200, ME],
      "/api/projects/a": [500, { error: { code: "internal", message: "x" } }],
      "/api/projects/a/issues/1": [301, { moved_to: { slug: "b", number: 2 } }],
    });
    renderAt("/projects/a/issues/1");

    expect(await screen.findByText(ABOVE)).toBeTruthy();
    expect(screen.queryByText(PROJECT_MISS_TEXT)).toBeNull();
  });

  it("still shows the tombstone to a reader who can read the old project", async () => {
    stubFetch({
      "/api/me": [200, ME],
      "/api/projects/a": [200, PROJECT_A],
      "/api/projects/a/issues/1": [
        410,
        { moved: true, title: "A card that went out of reach" },
      ],
    });
    renderAt("/projects/a/issues/1");

    expect(
      await screen.findByText(
        "This issue moved to a project you do not have access to.",
      ),
    ).toBeTruthy();
  });
});
