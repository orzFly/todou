import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import type { Project, SpecInfo } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecRouteError } from "../src/pages/issue-route-error.tsx";
import {
  ProjectLayout,
  ProjectRouteError,
} from "../src/pages/project-layout.tsx";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

// The real diff renders into a shadow root happy-dom cannot lay out, and no
// assertion here reaches the diff itself.
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  File: () => <div data-testid="file-view" />,
  CodeView: () => null,
}));

const AUTHOR = {
  id: 1,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const project = (slug: string): Project => ({
  id: slug === "a" ? 1 : 2,
  slug,
  name: slug,
  description: "",
  created_at: "2026-08-01T00:00:00.000Z",
  former_slugs: [],
});

const SPEC: SpecInfo = {
  current_version: 1,
  current_version_cursor: "c1",
  review_status: "unreviewed",
  unresolved_comments: 0,
  files: [{ path: "design.md", size: 7 }],
  versions: [
    {
      number: 1,
      author: AUTHOR,
      message: "v1",
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
};

const FILES = { version: 1, files: [{ path: "design.md", body: "Alpha.\n" }] };
const REF_CONFIG = { format: { prefix: "T-", history: [] }, autolinks: [] };

/** Marks the router boundary above the project layer. */
const ABOVE = "handled above the project layer";
const SPEC_MISS = "This spec does not exist, or you do not have access to it.";

type Reply = [status: number, body: unknown];

const NOT_FOUND: Reply = [
  404,
  { error: { code: "not_found", message: "not found" } },
];

/**
 * Answers from `table`, everything else 404. Stubbed at `fetch` rather than
 * at the api module so the real `errorFromBody` runs — a spied method could
 * only reject with a hand-built error, and which class it is is the thing
 * under test.
 */
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

/** Everything a spec page at `slug`/`number` reads, all 200. */
const specServed = (slug: string, number: number): Record<string, Reply> => ({
  [`/api/projects/${slug}`]: [200, project(slug)],
  [`/api/projects/${slug}/issues/${number}`]: [
    200,
    { number, title: "a card with a spec" },
  ],
  [`/api/projects/${slug}/issues/${number}/spec`]: [200, SPEC],
  [`/api/projects/${slug}/issues/${number}/spec/files`]: [200, FILES],
  [`/api/projects/${slug}/issues/${number}/spec/comments`]: [
    200,
    { current_version: 1, items: [] },
  ],
  [`/api/projects/${slug}/reference-config`]: [200, REF_CONFIG],
  [`/api/projects/${slug}/members`]: [200, []],
  "/api/me": [200, { id: 1, login: "bot-one", name: "Bot One" }],
});

/**
 * The real project layer and both real error boundaries over the real spec
 * page. The pathless "authed" id has to be here: `ProjectLayout` reads its
 * params from "/authed/projects/$slug" and throws without it.
 */
function renderAt(url: string) {
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
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>issue page</div>,
  });
  const specRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number/spec",
    component: SpecViewPage,
    validateSearch: parseSpecSearch,
    errorComponent: SpecRouteError,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([issueRoute, specRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
    defaultPendingMs: 0,
  });
  render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an old spec deep link (T-245)", () => {
  it("follows the move instead of crashing the router", async () => {
    stubFetch({
      ...specServed("b", 7),
      "/api/projects/a": [200, project("a")],
      "/api/projects/a/issues/1/spec": [
        301,
        { moved_to: { slug: "b", number: 7 } },
      ],
    });
    const router = renderAt("/projects/a/issues/1/spec");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/b/issues/7/spec"),
    );
    // The screen this card removes: the spec route is a sibling of the issue
    // route, so before it there was no boundary between a MovedError and the
    // router's own crash handler.
    expect(screen.queryByText(ABOVE)).toBeNull();
  });

  it("carries every search parameter across verbatim", async () => {
    stubFetch({
      ...specServed("b", 7),
      "/api/projects/a": [200, project("a")],
      "/api/projects/a/issues/1/spec": [
        301,
        { moved_to: { slug: "b", number: 7 } },
      ],
    });
    const router = renderAt(
      "/projects/a/issues/1/spec?v=1&file=design.md&compare=1&view=source",
    );

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/b/issues/7/spec"),
    );
    // None of the four is project-scoped — a move keeps spec version numbers
    // and leaves file paths alone — so all four survive the jump unchanged.
    expect(router.state.location.search).toEqual({
      v: 1,
      file: "design.md",
      compare: 1,
      view: "source",
    });
  });

  it("shows the tombstone to a reader who cannot see the destination", async () => {
    stubFetch({
      "/api/me": [200, { id: 1, login: "bot-one", name: "Bot One" }],
      "/api/projects/a": [200, project("a")],
      "/api/projects/a/issues/1": [200, { number: 1, title: "a card" }],
      "/api/projects/a/issues/1/spec": [
        410,
        { moved: true, title: "A spec that went out of reach" },
      ],
    });
    const router = renderAt("/projects/a/issues/1/spec");

    expect(
      await screen.findByText(
        "This issue moved to a project you do not have access to.",
      ),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe("/projects/a/issues/1/spec");
  });

  it("answers a 404 in its own words, without navigating", async () => {
    // Reached through the file read, not through `/spec` itself: specQuery
    // maps its own 404 to null so a spec-less card shows the page's empty
    // state, which leaves this branch for a spec that vanished under way.
    stubFetch({
      ...specServed("a", 1),
      "/api/projects/a/issues/1/spec/files": NOT_FOUND,
    });
    const router = renderAt("/projects/a/issues/1/spec");

    expect(await screen.findByText(SPEC_MISS)).toBeTruthy();
    expect(screen.queryByText(ABOVE)).toBeNull();
    expect(router.state.location.pathname).toBe("/projects/a/issues/1/spec");
  });

  it("reaches a reader of the destination alone as well", async () => {
    // This reader cannot read project a at all, so the project query 404s
    // beside the redirect. It lands anyway: the spec page suspends on its
    // own query, and the boundary that catches the MovedError sits below the
    // project layer. So this route needs no `resolvesProjectMiss` opt-in of
    // the kind T-244 gave the issue route, whose page reads project-scoped
    // queries the spec page does not.
    stubFetch({
      ...specServed("b", 7),
      "/api/projects/a": NOT_FOUND,
      "/api/projects/a/issues/1/spec": [
        301,
        { moved_to: { slug: "b", number: 7 } },
      ],
    });
    const router = renderAt("/projects/a/issues/1/spec");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/b/issues/7/spec"),
    );
    expect(
      screen.queryByText(
        "This project does not exist, or you do not have access to it.",
      ),
    ).toBeNull();
  });

  it("sends anything else up to the router's own boundary", async () => {
    stubFetch({
      ...specServed("a", 1),
      "/api/projects/a/issues/1/spec": [
        500,
        { error: { code: "internal", message: "x" } },
      ],
    });
    renderAt("/projects/a/issues/1/spec");

    // Same rule as ProjectRouteError: an error this boundary has no answer
    // for is not ours to dress up as an empty state.
    expect(await screen.findByText(ABOVE)).toBeTruthy();
    expect(screen.queryByText(SPEC_MISS)).toBeNull();
  });
});
