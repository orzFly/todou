import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type {
  IssueCounts,
  IssueListCacheDescriptor,
  IssueListItem,
  IssueListPage as IssueListPageData,
  Status,
} from "@todou/shared";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueSearchSchema, statusScopeOf } from "../src/api/issues.ts";
import { issueListDescriptorOf } from "../src/api/issues-cache.ts";
import { BoardPage } from "../src/pages/board.tsx";
import { IssueListPage } from "../src/pages/issue-list.tsx";
import { testQueryClient } from "./render.tsx";

const SLUG = "meta";

const status = (id: number, name: string, category: "open" | "closed") => ({
  id,
  name,
  category,
  color: "#123456",
  position: id,
  is_default: id === 1,
});

const STATUSES: Status[] = [
  status(1, "Todo", "open"),
  status(2, "Next", "open"),
  status(3, "Done", "closed"),
];

const item = (number: number, statusId: number): IssueListItem => ({
  id: number,
  number,
  title: `card ${number}`,
  status: STATUSES.find((s) => s.id === statusId) as Status,
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-09-07T00:00:00Z",
  updated_at: "2026-09-07T00:00:00Z",
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

/**
 * Two rows per status and always another page to fetch, so every "load more"
 * control renders and the paginated cache entries below are reachable.
 */
const COUNTS: IssueCounts = {
  open: 4,
  closed: 2,
  by_status: { "1": 2, "2": 2, "3": 2 },
};

const page = (statusId: number, cursor: string | null): IssueListPageData => ({
  items: [item(statusId * 10, statusId)],
  next_cursor: cursor,
});

const jsonOf = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Serves every endpoint the two pages read, by pathname, and reports the ones
 * it did not know — a page that fails to render because of an unstubbed call
 * would otherwise pass this file's cache sweep with an empty cache.
 */
function stubServer(): string[] {
  const unstubbed: string[] = [];
  vi.stubGlobal("fetch", (async (input: unknown) => {
    const url = new URL(String(input), "http://test");
    const path = url.pathname;
    if (path === `/api/projects/${SLUG}/statuses`) return jsonOf(STATUSES);
    if (path === `/api/projects/${SLUG}/labels`) return jsonOf([]);
    if (path === `/api/projects/${SLUG}/members`) return jsonOf([]);
    if (path === `/api/projects/${SLUG}/issues/counts`) return jsonOf(COUNTS);
    if (path === `/api/projects/${SLUG}/issues`) {
      const ids = url.searchParams.get("status");
      const statusId = ids === null ? 1 : Number(ids.split(",")[0]);
      // A second page exists until one has already been taken, which is what
      // stops "load more" from offering itself forever.
      const cursor = url.searchParams.get("cursor");
      return jsonOf(page(statusId, cursor === null ? "c1" : null));
    }
    if (path === `/api/projects/${SLUG}`) {
      return jsonOf({
        id: 1,
        slug: SLUG,
        name: "Meta",
        description: null,
        created_at: "2026-09-07T00:00:00Z",
        former_slugs: [],
      });
    }
    if (path === `/api/projects/${SLUG}/references/config`) {
      return jsonOf({
        format: { prefix: null, history: [] },
        autolinks: [],
      });
    }
    if (path === "/api/me/prefs") return jsonOf({});
    if (path === "/api/me") {
      return jsonOf({
        id: 1,
        login: "user",
        display_name: "User",
        kind: "human",
        avatar_url: null,
        owner: null,
        is_admin: true,
      });
    }
    unstubbed.push(path);
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  return unstubbed;
}

/** Mounts one of the two pages under the real route ids they read from. */
function mountAt(url: string) {
  const client = testQueryClient();
  const rootRoute = createRootRoute();
  // Both pages read their params strictly from "/authed/projects/$slug", so
  // the shim tree needs the same pathless "authed" id.
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const listRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    validateSearch: issueSearchSchema,
    component: () => (
      <Suspense fallback={<div>loading list</div>}>
        <IssueListPage />
      </Suspense>
    ),
  });
  const boardRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "board",
    component: () => (
      <Suspense fallback={<div>loading board</div>}>
        <BoardPage />
      </Suspense>
    ),
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>issue</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([listRoute, boardRoute, issueRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, ...utils };
}

/** Every `["issues", SLUG, …]` entry with the descriptor it declares. */
const declared = (client: ReturnType<typeof mountAt>["client"]) =>
  client
    .getQueryCache()
    .findAll({ queryKey: ["issues", SLUG] })
    .map((query) => ({
      key: query.queryKey,
      descriptor: issueListDescriptorOf(query.meta),
    }));

/**
 * The invariant every predicate in `applyInvalidation` rests on: an entry
 * that cannot say what it holds has to be refetched blind, so the value of
 * this whole card is exactly the share of entries that can (T-279).
 */
const expectAllDeclared = (
  entries: Array<{
    key: readonly unknown[];
    descriptor?: IssueListCacheDescriptor;
  }>,
  atLeast: number,
) => {
  expect(entries.length).toBeGreaterThanOrEqual(atLeast);
  expect(
    entries
      .filter((e) => e.descriptor === undefined)
      .map((e) => JSON.stringify(e.key)),
  ).toEqual([]);
  for (const { key, descriptor } of entries) {
    const scope = statusScopeOf(key);
    // A status-scoped key and its declared status filter are two spellings
    // of one fact; letting them disagree would skip the wrong column.
    if (scope !== null) {
      expect(descriptor?.filter.status).toEqual([scope]);
    }
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issue-list cache entries declare what they hold (T-279)", () => {
  it("covers every entry the board page produces", async () => {
    const unstubbed = stubServer();
    const { client, findByText } = mountAt(`/projects/${SLUG}/board`);
    await findByText("card 10");
    expect(unstubbed).toEqual([]);

    // One column per status, all under the same prefix.
    expectAllDeclared(declared(client), STATUSES.length);
    expect(
      declared(client)
        .map((e) => e.descriptor?.filter.status)
        .sort((a, b) => (a?.[0] ?? 0) - (b?.[0] ?? 0)),
    ).toEqual([[1], [2], [3]]);
  });

  it("covers the grouped list page, pagination included", async () => {
    const unstubbed = stubServer();
    const { client, findByText, findAllByText } = mountAt(`/projects/${SLUG}/`);
    await findByText("card 10");
    // A page that failed to render for want of a stub would leave an empty
    // cache, and every sweep below would pass on nothing.
    expect(unstubbed).toEqual([]);

    // Counts plus one group per open status; the closed group is not
    // rendered in the open category.
    expectAllDeclared(declared(client), 3);
    expect(
      declared(client).filter((e) => e.descriptor?.kind === "counts"),
    ).toHaveLength(1);

    const more = await findAllByText(/Show \d+ more…/);
    fireEvent.click(more[0] as HTMLElement);
    await waitFor(() =>
      expect(
        declared(client).filter((e) => e.descriptor?.filter.cursor === "c1"),
      ).toHaveLength(1),
    );
    expectAllDeclared(declared(client), 4);
  });

  it("covers the flat list page, pagination included", async () => {
    const unstubbed = stubServer();
    const { client, findByText } = mountAt(
      `/projects/${SLUG}/?group=none&category=all`,
    );
    await findByText("card 10");
    expect(unstubbed).toEqual([]);

    expectAllDeclared(declared(client), 2);
    fireEvent.click(await findByText("Load more"));
    await waitFor(() =>
      expect(
        declared(client).filter((e) => e.descriptor?.filter.cursor === "c1"),
      ).toHaveLength(1),
    );
    expectAllDeclared(declared(client), 3);
  });

  it("declares the trash undecidable rather than leaving it undeclared", async () => {
    // `deleted` is a filter no row's fields can answer, so the entry must
    // still carry a descriptor — the refetch comes from the filter being
    // undecidable, not from the declaration being missing.
    const unstubbed = stubServer();
    const { client, findByText } = mountAt(`/projects/${SLUG}/?deleted=1`);
    await findByText("Trash");
    expect(unstubbed).toEqual([]);

    const entries = declared(client);
    expectAllDeclared(entries, 1);
    expect(entries.some((e) => e.descriptor?.filter.deleted === true)).toBe(
      true,
    );
  });
});
