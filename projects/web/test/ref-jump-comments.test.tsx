import {
  focusManager,
  onlineManager,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  IssueListPage,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
  TimelineComment,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commentLocationQuery as displayCommentLocationQuery,
  commentRefQuery as displayCommentRefQuery,
  issueRefQuery as displayIssueRefQuery,
} from "../src/api/issue-refs.ts";
import { api, projectsQuery } from "../src/api/queries.ts";
import {
  type JumpDestination,
  type JumpRow,
  jumpDestinationPromise,
  useJumpRows,
} from "../src/api/ref-jump.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import {
  searchCommentLocationQuery as commentLocationQuery,
  searchCommentRefQuery as commentRefQuery,
  invalidateSearchRefQueries as invalidateIssueRefQueries,
  searchIssueRefQuery as issueRefQuery,
  type LocatedComment,
  type ResolvedCommentRef,
  type ResolvedIssueRef,
} from "../src/api/search-refs.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const alice = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const bob = { ...alice, id: 2, login: "bob", display_name: "Bob" };
const date = "2026-09-01T00:00:00Z";
const issue = (number = 12, title = "Confirmed parent"): IssueListItem => ({
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
  author: alice,
  assignees: [],
  labels: [],
  created_at: date,
  updated_at: date,
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
});
const comment = (id = 7, author = alice): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: "Comment body is not jump metadata",
  created_at: date,
  component: null,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});
const note = (
  slug = "todou",
  number = 12,
  commentId = 7,
  author = alice,
): ResolvedCommentRef => ({
  ...comment(commentId, author),
  at: { slug, number, commentId },
});
const location = (
  slug = "todou",
  number = 12,
  commentId = 7,
  author = alice,
): LocatedComment => ({
  slug,
  issue_number: number,
  issue_ref: `${slug}#${number}`,
  comment: comment(commentId, author),
});
const config = (prefix: string | null): ReferenceConfig => ({
  format: { prefix, history: [] },
  autolinks: [],
});
const directory: ReferenceDirectory = {
  entries: [
    { prefix: "T", slug: "todou", from: "2020-01-01T00:00:00Z", to: null },
    { prefix: "HB", slug: "harbor", from: "2020-01-01T00:00:00Z", to: null },
  ],
  contested: [],
};
const projects: Project[] = ["todou", "harbor", "9"].map((slug, i) => ({
  id: i + 1,
  slug,
  name: slug,
  description: "",
  icon_url: null,
  created_at: date,
}));
const clients: QueryClient[] = [];
const unfinished: (() => void)[] = [];
const tasks: Promise<unknown>[] = [];

function track<T>(promise: Promise<T>): Promise<T> {
  tasks.push(promise);
  // Assertions may fail while a request is held. Teardown still owns it.
  void promise.catch(() => {});
  return promise;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void promise.catch(() => {});
  unfinished.push(() => reject(new Error("test request disposed")));
  return { promise, resolve, reject };
}

function seedContext(client: QueryClient, prefix: string | null = "T") {
  client.setQueryData(referenceConfigQuery("todou").queryKey, config(prefix));
  client.setQueryData(referenceConfigQuery("harbor").queryKey, config("HB"));
  client.setQueryData(referenceConfigQuery("9").queryKey, config(null));
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  client.setQueryData(projectsQuery.queryKey, projects);
}

function seeded(prefix: string | null = "T") {
  const client = testQueryClient();
  clients.push(client);
  seedContext(client, prefix);
  return client;
}

const shapes = ["attached", "bare"] as const;
type Shape = (typeof shapes)[number];
const consumers = ["hook", "promise"] as const;
type Consumer = (typeof consumers)[number];
const queryText = (shape: Shape) =>
  shape === "attached" ? "T-12#comment-7" : "#comment-7";
const commentKey = (shape: Shape, slug = "todou") =>
  shape === "attached"
    ? commentRefQuery(slug, 12, 7).queryKey
    : commentLocationQuery(slug, 7).queryKey;

function seedComment(client: QueryClient, shape: Shape, slug = "todou") {
  if (shape === "attached") {
    client.setQueryData(commentRefQuery(slug, 12, 7).queryKey, note(slug));
  } else {
    client.setQueryData(commentLocationQuery(slug, 7).queryKey, location(slug));
  }
}

function seedTarget(client: QueryClient, shape: Shape) {
  client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
  seedComment(client, shape);
}

function Probe({ q, slug }: { q: string; slug: string }) {
  return <pre data-testid="rows">{JSON.stringify(useJumpRows(slug, q))}</pre>;
}
type View = { container: HTMLElement };
function rows(view: View): JumpRow[] {
  const pre = view.container.querySelector("[data-testid='rows']");
  expect(pre).not.toBeNull();
  return JSON.parse(pre?.textContent ?? "[]") as JumpRow[];
}
function expectNoReady(view: View) {
  expect(
    rows(view).filter((row) => row.kind === "issue" && row.state === "ready"),
  ).toEqual([]);
  expect(view.container.textContent).not.toContain("Confirmed parent");
  expect(view.container.textContent).not.toContain('"commentBy":"Alice"');
}
function expectPending(view: View) {
  expect(rows(view)).toMatchObject([{ kind: "issue", state: "pending" }]);
  expect(rows(view)).toHaveLength(1);
  expectNoReady(view);
}
type Expected = {
  slug: string;
  number: number;
  commentId: number;
  spelled: string;
  title?: string;
  author?: string;
};
const local: Expected = {
  slug: "todou",
  number: 12,
  commentId: 7,
  spelled: "T-12#comment-7",
};
const moved: Expected = {
  slug: "harbor",
  number: 55,
  commentId: 8,
  spelled: "harbor/HB-55#comment-8",
  title: "Destination parent",
};
function destination(expected: Expected): JumpDestination {
  return {
    kind: "issue",
    target: {
      slug: expected.slug,
      number: expected.number,
      commentId: expected.commentId,
    },
  };
}
function expectReady(view: View, expected = local, pageSlug = "todou") {
  expect(rows(view)).toHaveLength(1);
  expect(rows(view)[0]).toMatchObject({
    kind: "issue",
    state: "ready",
    slug: expected.slug,
    number: expected.number,
    commentId: expected.commentId,
    spelled: expected.spelled,
    item: {
      number: expected.number,
      title: expected.title ?? "Confirmed parent",
    },
    commentBy: expected.author ?? "Alice",
    crossProject: expected.slug !== pageSlug,
  });
  expect(view.container.textContent).not.toContain("Comment body");
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function clock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  focusManager.setFocused(true);
}
async function mount(client: QueryClient, q: string, slug = "todou") {
  const view = renderWithProviders(<Probe q={q} slug={slug} />, client);
  if (vi.isFakeTimers()) await advance(1);
  else await waitFor(() => expect(rows(view)).toBeDefined());
  return view;
}
async function flush() {
  if (vi.isFakeTimers()) await advance(1);
  else {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}
function enter(client: QueryClient, q: string, slug = "todou") {
  let settled = false;
  const promise = track(jumpDestinationPromise(client, slug, q));
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { promise, settled: () => settled };
}
async function expectAccepted(
  consumer: Consumer,
  client: QueryClient,
  q: string,
  expected = local,
) {
  if (consumer === "promise") {
    expect(await enter(client, q).promise).toEqual(destination(expected));
  } else {
    const view = await mount(client, q);
    await waitFor(() => expectReady(view, expected));
  }
}
async function expectRejected(
  consumer: Consumer,
  client: QueryClient,
  q: string,
  slug = "todou",
) {
  if (consumer === "promise") {
    expect(await enter(client, q, slug).promise).toBeNull();
  } else {
    const view = await mount(client, q, slug);
    await waitFor(() => expect(rows(view)).toEqual([]));
  }
}
const page = (title = "Confirmed parent"): IssueListPage => ({
  items: [issue(12, title)],
  next_cursor: null,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Dispose observers and query work while their timers still belong to this test.
// No deliberately never-resolving queryFn is allowed to escape to another case.
afterEach(async () => {
  cleanup();
  await Promise.all(clients.map((client) => client.cancelQueries()));
  onlineManager.setOnline(true);
  for (const finish of unfinished.splice(0)) finish();
  await Promise.allSettled(tasks.splice(0));
  for (const client of clients.splice(0)) client.clear();
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(1);
    vi.clearAllTimers();
  }
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(consumers)("comment jump confirmation through %s", (consumer) => {
  it.each(shapes)(
    "uses the final full address and different ID for %s migration",
    async (shape) => {
      const client = seeded();
      if (shape === "attached") {
        client.setQueryData<ResolvedIssueRef | null>(
          issueRefQuery("todou", 12).queryKey,
          () => ({
            ...issue(55, "Destination parent"),
            at: { slug: "harbor", number: 55 },
          }),
        );
        client.setQueryData(
          commentRefQuery("todou", 12, 7).queryKey,
          note("harbor", 55, 8),
        );
      } else {
        client.setQueryData(
          commentLocationQuery("todou", 7).queryKey,
          location("harbor", 55, 8),
        );
        // A located parent is queried at its destination, not at todou/55.
        client.setQueryData(
          issueRefQuery("harbor", 55).queryKey,
          issue(55, "Destination parent"),
        );
      }
      await expectAccepted(consumer, client, queryText(shape), moved);
    },
  );

  it.each(shapes)(
    "accepts a numeric source once the %s destination is confirmed",
    async (shape) => {
      const client = seeded();
      if (shape === "attached") {
        client.setQueryData<ResolvedIssueRef | null>(
          issueRefQuery("9", 12).queryKey,
          () => ({
            ...issue(55, "Destination parent"),
            at: { slug: "harbor", number: 55 },
          }),
        );
        client.setQueryData(
          commentRefQuery("9", 12, 7).queryKey,
          note("harbor", 55, 8),
        );
      } else {
        client.setQueryData(
          commentLocationQuery("9", 7).queryKey,
          location("harbor", 55, 8),
        );
        client.setQueryData(
          issueRefQuery("harbor", 55).queryKey,
          issue(55, "Destination parent"),
        );
      }
      const q = shape === "attached" ? "#12#comment-7" : "#comment-7";
      if (consumer === "promise") {
        expect(await enter(client, q, "9").promise).toEqual(destination(moved));
      } else {
        const view = await mount(client, q, "9");
        await waitFor(() => expectReady(view, moved, "9"));
      }
    },
  );

  it.each(shapes)(
    "follows %s aliases through the shared client's HTTP MovedError response",
    async (shape) => {
      const client = seeded();
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input), window.location.origin);
          const path = url.pathname.replace(/^\/api/, "");
          requests.push(path);
          if (
            path === "/projects/todou/issues" &&
            url.searchParams.has("numbers")
          ) {
            return json(
              {
                error: {
                  code: "forbidden",
                  message: "Source list unavailable",
                },
              },
              403,
            );
          }
          if (path === "/projects/todou/issues/12") {
            return json({ moved_to: { slug: "harbor", number: 55 } }, 301);
          }
          if (
            path === "/projects/todou/issues/12/comments/7" ||
            path === "/projects/todou/comments/7"
          ) {
            return json(
              { moved_to: { slug: "harbor", number: 55, comment_id: 8 } },
              301,
            );
          }
          if (path === "/projects/harbor/issues/55/comments/8") {
            return json(comment(8));
          }
          if (path === "/projects/harbor/issues/55") {
            return json({ ...issue(55, "Destination parent"), body: "" });
          }
          if (
            path === "/projects/harbor/issues" &&
            url.searchParams.has("numbers")
          ) {
            return json({
              items: [issue(55, "Destination parent")],
              next_cursor: null,
            });
          }
          throw new Error(`Unexpected jump request: ${path}${url.search}`);
        }),
      );
      await expectAccepted(consumer, client, queryText(shape), moved);
      expect(requests).toContain(
        shape === "attached"
          ? "/projects/todou/issues/12/comments/7"
          : "/projects/todou/comments/7",
      );
      expect(
        requests.filter(
          (path) => path === "/projects/harbor/issues/55/comments/8",
        ),
      ).toHaveLength(1);
      expect(requests).not.toContain("/projects/harbor/issues/55/comments/7");
      if (shape === "bare") {
        expect(
          client.getQueryData(commentRefQuery("harbor", 55, 8).queryKey),
        ).toBeUndefined();
      }
    },
  );

  it.each(shapes)(
    "accepts a hidden and resolved %s comment with no project prefix",
    async (shape) => {
      const client = seeded(null);
      client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
      const hidden = { ...comment(), hidden_at: date, resolved_at: date };
      if (shape === "attached") {
        client.setQueryData<ResolvedCommentRef | null>(
          commentRefQuery("todou", 12, 7).queryKey,
          () => ({
            ...hidden,
            at: { slug: "todou", number: 12, commentId: 7 },
          }),
        );
      } else {
        // No slug on a non-moved location response is the normal wire shape.
        client.setQueryData<LocatedComment | null>(
          commentLocationQuery("todou", 7).queryKey,
          () => ({
            issue_number: 12,
            issue_ref: "#12",
            comment: hidden,
          }),
        );
      }
      await expectAccepted(
        consumer,
        client,
        shape === "attached" ? "#12#comment-7" : "#comment-7",
        { ...local, spelled: "#12#comment-7" },
      );
    },
  );

  describe.each(shapes)("%s parent gates", (shape) => {
    it.each([
      "missing",
      "deleted",
      "wrong project",
      "wrong number",
      "numeric unconfirmed",
    ] as const)(
      "rejects a %s parent despite a confirmed comment",
      async (reason) => {
        const client = seeded();
        const slug = reason === "numeric unconfirmed" ? "9" : "todou";
        seedComment(client, shape, slug);
        const parent: ResolvedIssueRef | null =
          reason === "missing"
            ? null
            : reason === "deleted"
              ? { ...issue(), deleted_at: date }
              : reason === "wrong project"
                ? { ...issue(), at: { slug: "harbor", number: 12 } }
                : reason === "wrong number"
                  ? { ...issue(55), at: { slug, number: 55 } }
                  : issue();
        client.setQueryData(issueRefQuery(slug, 12).queryKey, parent);
        const q = shape === "bare" ? "#comment-7" : "#12#comment-7";
        await expectRejected(consumer, client, q, slug);
      },
    );
  });

  describe.each(shapes)("%s comment gates", (shape) => {
    it("waits for a pending comment before offering a destination", async () => {
      const client = seeded();
      client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
      const request = deferred<TimelineComment>();
      const located = deferred<LocatedComment>();
      const fetch =
        shape === "attached"
          ? vi.spyOn(api, "getComment").mockReturnValue(request.promise)
          : vi.spyOn(api, "locateComment").mockReturnValue(located.promise);
      const view =
        consumer === "hook" ? await mount(client, queryText(shape)) : null;
      const entered =
        consumer === "promise" ? enter(client, queryText(shape)) : null;
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await flush();
      if (view) expectPending(view);
      if (entered) expect(entered.settled()).toBe(false);
      await act(async () => {
        request.resolve(comment());
        located.resolve(location());
      });
      if (view) await waitFor(() => expectReady(view));
      if (entered) expect(await entered.promise).toEqual(destination(local));
    });

    it("rejects a cached null comment", async () => {
      const client = seeded();
      client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
      client.setQueryData(commentKey(shape), null);
      await expectRejected(consumer, client, queryText(shape));
    });

    it.each([403, 404, "network"] as const)(
      "rejects comment lookup failure %s",
      async (failure) => {
        const client = seeded();
        client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
        const error =
          failure === "network" ? new Error("offline") : { status: failure };
        const fetch =
          shape === "attached"
            ? vi.spyOn(api, "getComment").mockRejectedValue(error)
            : vi.spyOn(api, "locateComment").mockRejectedValue(error);
        await expectRejected(consumer, client, queryText(shape));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(client.getQueryState(commentKey(shape))?.status).toBe(
          failure === "network" ? "error" : "success",
        );
        if (failure !== "network")
          expect(client.getQueryData(commentKey(shape))).toBeNull();
      },
    );
  });

  it("rejects an attached comment whose body ID differs from at.commentId", async () => {
    const client = seeded();
    client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
    client.setQueryData<ResolvedCommentRef | null>(
      commentRefQuery("todou", 12, 7).queryKey,
      () => ({
        ...note(),
        id: 8,
      }),
    );
    await expectRejected(consumer, client, queryText("attached"));
  });

  it("still offers a plain issue without any comment confirmation", async () => {
    const client = seeded();
    client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
    const getComment = vi
      .spyOn(api, "getComment")
      .mockRejectedValue(new Error("not a comment"));
    const locateComment = vi
      .spyOn(api, "locateComment")
      .mockRejectedValue(new Error("not a comment"));
    if (consumer === "promise") {
      expect(await enter(client, "T-12").promise).toEqual({
        kind: "issue",
        target: { slug: "todou", number: 12 },
      });
    } else {
      const view = await mount(client, "T-12");
      expect(rows(view)).toMatchObject([
        {
          state: "ready",
          slug: "todou",
          number: 12,
          spelled: "T-12",
          commentBy: null,
        },
      ]);
      expect(rows(view)[0]).not.toHaveProperty("commentId");
    }
    expect(getComment).not.toHaveBeenCalled();
    expect(locateComment).not.toHaveBeenCalled();
  });
});

describe.each(shapes)("%s active comment jump lifetime", (shape) => {
  it.each(["parent", "comment"] as const)(
    "withdraws at 60s while %s revalidates, stays withdrawn on rejection, then recovers",
    async (held) => {
      clock();
      const client = seeded();
      seedTarget(client, shape);
      const parent = deferred<IssueListPage>();
      const request = deferred<TimelineComment>();
      const located = deferred<LocatedComment>();
      const list = vi
        .spyOn(api, "listIssues")
        .mockImplementation(() =>
          held === "parent" ? parent.promise : Promise.resolve(page()),
        );
      vi.spyOn(api, "getIssue").mockRejectedValue(new Error("parent offline"));
      const getComment = vi
        .spyOn(api, "getComment")
        .mockImplementation(() =>
          held === "comment" ? request.promise : Promise.resolve(comment()),
        );
      const locateComment = vi
        .spyOn(api, "locateComment")
        .mockImplementation(() =>
          held === "comment" ? located.promise : Promise.resolve(location()),
        );
      const view = await mount(client, queryText(shape));
      expectReady(view);
      await advance(59_998);
      expect(list).not.toHaveBeenCalled();
      expect(getComment).not.toHaveBeenCalled();
      expect(locateComment).not.toHaveBeenCalled();
      expectReady(view);
      await advance(1);
      await advance(1); // issue batching runs one timer after the 60-second deadline
      const heldKey =
        held === "parent"
          ? issueRefQuery("todou", 12).queryKey
          : commentKey(shape);
      expect(client.getQueryState(heldKey)?.fetchStatus).toBe("fetching");
      expectPending(view);
      // Context is independent metadata; keep Enter's context warm while testing refs.
      seedContext(client);
      const entered = enter(client, queryText(shape));
      await flush();
      expect(entered.settled()).toBe(false);
      await act(async () => {
        if (held === "parent") parent.reject(new Error("list offline"));
        else if (shape === "attached")
          request.reject(new Error("comment offline"));
        else located.reject(new Error("location offline"));
      });
      expect(await entered.promise).toBeNull();
      await advance(1);
      expect(client.getQueryState(heldKey)?.status).toBe("error");
      expect(rows(view)).toEqual([]);
      expectNoReady(view);

      list.mockResolvedValue(page("Recovered parent"));
      getComment.mockResolvedValue(comment(7, bob));
      locateComment.mockResolvedValue(location("todou", 12, 7, bob));
      const refresh = track(invalidateIssueRefQueries(client));
      await advance(1);
      await act(async () => {
        await refresh;
      });
      await advance(1);
      const recovered = { ...local, title: "Recovered parent", author: "Bob" };
      expectReady(view, recovered);
      expect(await enter(client, queryText(shape)).promise).toEqual(
        destination(recovered),
      );
    },
  );

  it("withdraws an invalidated Enter generation and ignores its late successful response", async () => {
    const client = seeded();
    seedTarget(client, shape);
    const request = deferred<TimelineComment>();
    const located = deferred<LocatedComment>();
    const getComment = vi
      .spyOn(api, "getComment")
      .mockReturnValue(request.promise);
    const locateComment = vi
      .spyOn(api, "locateComment")
      .mockReturnValue(located.promise);
    const view = await mount(client, queryText(shape));
    expectReady(view);
    const refresh = track(
      client.refetchQueries({ queryKey: commentKey(shape), exact: true }),
    );
    await waitFor(() =>
      expect(client.getQueryState(commentKey(shape))?.fetchStatus).toBe(
        "fetching",
      ),
    );
    const entered = enter(client, queryText(shape));
    await flush();
    expect(entered.settled()).toBe(false);
    await act(async () => {
      await invalidateIssueRefQueries(
        client,
        { slug: "todou", commentId: 7 },
        { refetchType: "none" },
      );
    });
    await flush();
    expect(entered.settled()).toBe(true);
    expect(await entered.promise).toBeNull();
    await waitFor(() => expectNoReady(view));
    await act(async () => {
      request.resolve(comment());
      located.resolve(location());
      await refresh;
    });
    await flush();
    expectNoReady(view);
    expect(client.getQueryState(commentKey(shape))?.isInvalidated).toBe(true);
    getComment.mockResolvedValue(comment(7, bob));
    locateComment.mockResolvedValue(location("todou", 12, 7, bob));
    await act(async () => {
      await invalidateIssueRefQueries(client, { slug: "todou", commentId: 7 });
    });
    await waitFor(() => expectReady(view, { ...local, author: "Bob" }));
    expect(await enter(client, queryText(shape)).promise).toEqual(
      destination(local),
    );
  });

  it("checks the latest comment cache after another dependent parent lookup completes", async () => {
    const client = seeded();
    seedComment(client, shape);
    const parent = deferred<IssueListPage>();
    const list = vi.spyOn(api, "listIssues").mockReturnValue(parent.promise);
    const view = await mount(client, queryText(shape));
    const entered = enter(client, queryText(shape));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await flush();
    expectPending(view);
    expect(entered.settled()).toBe(false);
    await act(async () => {
      await client.invalidateQueries({
        queryKey: commentKey(shape),
        exact: true,
        refetchType: "none",
      });
    });
    await act(async () => {
      parent.resolve(page());
    });
    expect(await entered.promise).toBeNull();
    await waitFor(() =>
      expect(
        client.getQueryState(issueRefQuery("todou", 12).queryKey)?.fetchStatus,
      ).toBe("idle"),
    );
    expect(client.getQueryState(commentKey(shape))?.isInvalidated).toBe(true);
    expectNoReady(view);
  });

  it.each(["parent", "comment"] as const)(
    "Enter joins a fresh-cache background %s fetch and the hook withdraws until it finishes",
    async (held) => {
      const client = seeded();
      seedTarget(client, shape);
      const parent = deferred<IssueListPage>();
      const request = deferred<TimelineComment>();
      const located = deferred<LocatedComment>();
      vi.spyOn(api, "listIssues").mockReturnValue(parent.promise);
      vi.spyOn(api, "getComment").mockReturnValue(request.promise);
      vi.spyOn(api, "locateComment").mockReturnValue(located.promise);
      const view = await mount(client, queryText(shape));
      expectReady(view);
      const key =
        held === "parent"
          ? issueRefQuery("todou", 12).queryKey
          : commentKey(shape);
      const updatedAt = client.getQueryState(key)?.dataUpdatedAt;
      const refresh = track(
        client.refetchQueries({ queryKey: key, exact: true }),
      );
      await waitFor(() =>
        expect(client.getQueryState(key)?.fetchStatus).toBe("fetching"),
      );
      expect(client.getQueryState(key)).toMatchObject({
        isInvalidated: false,
        dataUpdatedAt: updatedAt,
      });
      expect(Date.now() - (updatedAt ?? 0)).toBeLessThan(60_000);
      const entered = enter(client, queryText(shape));
      await flush();
      expectPending(view);
      expect(entered.settled()).toBe(false);
      await act(async () => {
        parent.resolve(page("Updated parent"));
        request.resolve(comment(7, bob));
        located.resolve(location("todou", 12, 7, bob));
        await refresh;
      });
      expect(await entered.promise).toEqual(destination(local));
      await waitFor(() =>
        expectReady(view, {
          ...local,
          title: held === "parent" ? "Updated parent" : "Confirmed parent",
          author: held === "comment" ? "Bob" : "Alice",
        }),
      );
    },
  );

  it.each(["parent", "comment"] as const)(
    "keeps fresh cached metadata withdrawn after a background %s rejection",
    async (held) => {
      const client = seeded();
      seedTarget(client, shape);
      const parent = deferred<IssueListPage>();
      const request = deferred<TimelineComment>();
      const located = deferred<LocatedComment>();
      vi.spyOn(api, "listIssues").mockReturnValue(parent.promise);
      vi.spyOn(api, "getIssue").mockRejectedValue(new Error("parent offline"));
      vi.spyOn(api, "getComment").mockReturnValue(request.promise);
      vi.spyOn(api, "locateComment").mockReturnValue(located.promise);
      const view = await mount(client, queryText(shape));
      expectReady(view);
      const key =
        held === "parent"
          ? issueRefQuery("todou", 12).queryKey
          : commentKey(shape);
      const updatedAt = client.getQueryState(key)?.dataUpdatedAt;
      const refresh = track(
        client.refetchQueries({ queryKey: key, exact: true }),
      );
      const entered = enter(client, queryText(shape));
      await flush();
      expectPending(view);
      expect(entered.settled()).toBe(false);
      await act(async () => {
        if (held === "parent") parent.reject(new Error("list offline"));
        else if (shape === "attached") request.reject(new Error("offline"));
        else located.reject(new Error("offline"));
        await refresh;
      });
      expect(await entered.promise).toBeNull();
      await waitFor(() => expect(rows(view)).toEqual([]));
      expect(client.getQueryState(key)).toMatchObject({
        status: "error",
        dataUpdatedAt: updatedAt,
        isInvalidated: true,
      });
      // Query Core invalidates retained data on a background error even when
      // its timestamp is still young. Age and non-null data alone cannot confirm it.
      expect(Date.now() - (updatedAt ?? 0)).toBeLessThan(60_000);
      expect(client.getQueryData(key)).not.toBeNull();
      expectNoReady(view);
    },
  );

  it.each(["parent", "comment"] as const)(
    "withdraws a fresh cached target while an offline %s refresh is paused",
    async (held) => {
      focusManager.setFocused(true);
      const client = seeded();
      seedTarget(client, shape);
      const parent = deferred<IssueListPage>();
      const request = deferred<TimelineComment>();
      const located = deferred<LocatedComment>();
      const list = vi.spyOn(api, "listIssues").mockReturnValue(parent.promise);
      const getComment = vi
        .spyOn(api, "getComment")
        .mockReturnValue(request.promise);
      const locateComment = vi
        .spyOn(api, "locateComment")
        .mockReturnValue(located.promise);
      const view = await mount(client, queryText(shape));
      expectReady(view);
      const key =
        held === "parent"
          ? issueRefQuery("todou", 12).queryKey
          : commentKey(shape);
      const updatedAt = client.getQueryState(key)?.dataUpdatedAt;
      await act(async () => {
        onlineManager.setOnline(false);
        await client.refetchQueries({ queryKey: key, exact: true });
      });
      expect(client.getQueryState(key)).toMatchObject({
        fetchStatus: "paused",
        isInvalidated: false,
        dataUpdatedAt: updatedAt,
      });
      const entered = enter(client, queryText(shape));
      await flush();
      expectPending(view);
      expect(entered.settled()).toBe(false);
      expect(list).not.toHaveBeenCalled();
      expect(getComment).not.toHaveBeenCalled();
      expect(locateComment).not.toHaveBeenCalled();
      await act(async () => {
        onlineManager.setOnline(true);
      });
      const fetch =
        held === "parent"
          ? list
          : shape === "attached"
            ? getComment
            : locateComment;
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expectPending(view);
      expect(entered.settled()).toBe(false);
      await act(async () => {
        parent.resolve(page());
        request.resolve(comment());
        located.resolve(location());
      });
      expect(await entered.promise).toEqual(destination(local));
      await waitFor(() => expectReady(view));
    },
  );
});

describe("bare location keeps its own confirmation age", () => {
  it("revalidates an old location at its original deadline without renewing it through comment-ref", async () => {
    clock();
    const client = seeded();
    client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
    const updatedAt = Date.now() - 59_000;
    client.setQueryData(commentLocationQuery("todou", 7).queryKey, location(), {
      updatedAt,
    });
    const request = deferred<LocatedComment>();
    const locateComment = vi
      .spyOn(api, "locateComment")
      .mockReturnValue(request.promise);
    const getComment = vi.spyOn(api, "getComment").mockResolvedValue(comment());
    const view = await mount(client, "#comment-7");
    expectReady(view);
    expect(await enter(client, "#comment-7").promise).toEqual(
      destination(local),
    );
    expect(
      client.getQueryState(commentLocationQuery("todou", 7).queryKey)
        ?.dataUpdatedAt,
    ).toBe(updatedAt);
    expect(
      client.getQueryData(commentRefQuery("todou", 12, 7).queryKey),
    ).toBeUndefined();
    expect(getComment).not.toHaveBeenCalled();
    await advance(998);
    expect(locateComment).not.toHaveBeenCalled();
    expectReady(view);
    await advance(2);
    expect(locateComment).toHaveBeenCalledTimes(1);
    expectPending(view);
    expect(
      client.getQueryState(commentLocationQuery("todou", 7).queryKey)
        ?.dataUpdatedAt,
    ).toBe(updatedAt);
    await act(async () => {
      request.reject(new Error("location offline"));
    });
    await advance(1);
    expect(rows(view)).toEqual([]);
    expect(getComment).not.toHaveBeenCalled();
  });

  it("returns null if location freshness expires while Enter holds the dependent parent request", async () => {
    clock();
    const client = seeded();
    const updatedAt = Date.now() - 59_900;
    client.setQueryData(commentLocationQuery("todou", 7).queryKey, location(), {
      updatedAt,
    });
    const parent = deferred<IssueListPage>();
    const list = vi.spyOn(api, "listIssues").mockReturnValue(parent.promise);
    const locateComment = vi
      .spyOn(api, "locateComment")
      .mockResolvedValue(location());
    const getComment = vi.spyOn(api, "getComment").mockResolvedValue(comment());
    const entered = enter(client, "#comment-7");
    await advance(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(entered.settled()).toBe(false);
    await advance(100);
    await act(async () => {
      parent.resolve(page());
    });
    expect(await entered.promise).toBeNull();
    expect(
      client.getQueryState(commentLocationQuery("todou", 7).queryKey)
        ?.dataUpdatedAt,
    ).toBe(updatedAt);
    expect(
      client.getQueryData(commentRefQuery("todou", 12, 7).queryKey),
    ).toBeUndefined();
    expect(locateComment).not.toHaveBeenCalled();
    expect(getComment).not.toHaveBeenCalled();
  });
});

describe("attached Enter rereads its earlier parent confirmation", () => {
  it("returns null if the parent expires while the comment request is held", async () => {
    clock();
    const client = seeded();
    const updatedAt = Date.now() - 59_900;
    client.setQueryData(issueRefQuery("todou", 12).queryKey, issue(), {
      updatedAt,
    });
    const request = deferred<TimelineComment>();
    const getComment = vi
      .spyOn(api, "getComment")
      .mockReturnValue(request.promise);
    const list = vi.spyOn(api, "listIssues").mockResolvedValue(page());
    const entered = enter(client, queryText("attached"));
    await advance(1);
    expect(getComment).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(entered.settled()).toBe(false);
    await advance(100);
    await act(async () => {
      request.resolve(comment());
    });
    expect(await entered.promise).toBeNull();
    expect(
      client.getQueryState(issueRefQuery("todou", 12).queryKey)?.dataUpdatedAt,
    ).toBe(updatedAt);
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects a parent invalidated without refetch while the comment is pending", async () => {
    const client = seeded();
    client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
    const request = deferred<TimelineComment>();
    const getComment = vi
      .spyOn(api, "getComment")
      .mockReturnValue(request.promise);
    const view = await mount(client, queryText("attached"));
    const entered = enter(client, queryText("attached"));
    await waitFor(() => expect(getComment).toHaveBeenCalledTimes(1));
    await flush();
    expectPending(view);
    expect(entered.settled()).toBe(false);
    await act(async () => {
      await client.invalidateQueries({
        queryKey: issueRefQuery("todou", 12).queryKey,
        exact: true,
        refetchType: "none",
      });
    });
    await act(async () => {
      request.resolve(comment());
    });
    expect(await entered.promise).toBeNull();
    expect(
      client.getQueryState(issueRefQuery("todou", 12).queryKey)?.isInvalidated,
    ).toBe(true);
    await waitFor(() => expectNoReady(view));
  });
});

it("keeps a plain issue available while its fresh-cache refresh is paused", async () => {
  focusManager.setFocused(true);
  const client = seeded();
  client.setQueryData(issueRefQuery("todou", 12).queryKey, issue());
  const list = vi.spyOn(api, "listIssues").mockResolvedValue(page());
  const view = await mount(client, "T-12");
  await act(async () => {
    onlineManager.setOnline(false);
    await client.refetchQueries({
      queryKey: issueRefQuery("todou", 12).queryKey,
      exact: true,
    });
  });
  expect(
    client.getQueryState(issueRefQuery("todou", 12).queryKey)?.fetchStatus,
  ).toBe("paused");
  await flush();
  expect(rows(view)).toMatchObject([
    {
      state: "ready",
      slug: "todou",
      number: 12,
      spelled: "T-12",
      commentBy: null,
    },
  ]);
  expect(rows(view)[0]).not.toHaveProperty("commentId");
  expect(await enter(client, "T-12").promise).toEqual({
    kind: "issue",
    target: { slug: "todou", number: 12 },
  });
  expect(list).not.toHaveBeenCalled();
  await act(async () => {
    onlineManager.setOnline(true);
  });
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
});

describe.each(consumers)("search cache isolation through %s", (consumer) => {
  describe.each(shapes)("%s comment address", (shape) => {
    it.each([false, true])(
      "fetches live confirmations without writing display cache (seeded: %s)",
      async (seedDisplay) => {
        const client = seeded();
        const displayIssue = displayIssueRefQuery("todou", 12).queryKey;
        const displayComment = displayCommentRefQuery("todou", 12, 7).queryKey;
        const displayLocation = displayCommentLocationQuery(
          "todou",
          7,
        ).queryKey;
        if (seedDisplay) {
          client.setQueryData(
            displayIssue,
            issue(12, "Persistent display title"),
          );
          client.setQueryData(displayComment, note("todou", 12, 7, bob));
          client.setQueryData(displayLocation, location("todou", 12, 7, bob));
        }
        const displayKeys = [displayIssue, displayComment, displayLocation];
        const before = displayKeys.map((key) => client.getQueryState(key));
        const list = vi.spyOn(api, "listIssues").mockResolvedValue(page());
        const getComment = vi
          .spyOn(api, "getComment")
          .mockResolvedValue(comment());
        const locateComment = vi
          .spyOn(api, "locateComment")
          .mockResolvedValue(location());

        await expectAccepted(consumer, client, queryText(shape));

        expect(list).toHaveBeenCalledTimes(1);
        expect(getComment).toHaveBeenCalledTimes(shape === "attached" ? 1 : 0);
        expect(locateComment).toHaveBeenCalledTimes(shape === "bare" ? 1 : 0);
        expect(
          client.getQueryData(issueRefQuery("todou", 12).queryKey),
        ).toEqual(issue());
        expect(client.getQueryData(commentKey(shape))).toEqual(
          shape === "attached" ? note() : location(),
        );
        await act(async () => {
          await invalidateIssueRefQueries(client, {}, { refetchType: "none" });
        });
        expect(
          client.getQueryState(issueRefQuery("todou", 12).queryKey)
            ?.isInvalidated,
        ).toBe(true);
        expect(client.getQueryState(commentKey(shape))?.isInvalidated).toBe(
          true,
        );
        for (const [index, key] of displayKeys.entries()) {
          expect(client.getQueryState(key)).toBe(before[index]);
        }
      },
    );
  });
});
