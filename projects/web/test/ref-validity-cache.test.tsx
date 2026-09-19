import { focusManager, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import {
  type IssueListItem,
  type IssueListPage,
  type Me,
  MePrefs,
  type ReferenceConfig,
  type TimelineComment,
} from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commentRefQuery,
  invalidateIssueRefQueries,
  issueRefQuery,
  type ResolvedCommentRef,
  type ResolvedIssueRef,
} from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { api } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { AppShell } from "../src/components/shell.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "todou";
const ISSUE_HREF = "/projects/todou/issues/7";
const COMMENT_HREF = `${ISSUE_HREF}#comment-42`;
const config: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};
const alice = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const bob = { ...alice, id: 2, login: "bob", display_name: "Bob" };

const issue = (title: string): IssueListItem => ({
  id: 7,
  number: 7,
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
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
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
const comment = (author = alice): TimelineComment => ({
  type: "comment",
  id: 42,
  author,
  body: "hello",
  created_at: "2026-08-12T00:00:00Z",
  component: null,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});
const page = (title: string): IssueListPage => ({
  items: [issue(title)],
  next_cursor: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seeded(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery(SLUG).queryKey, config);
  client.setQueryData(prefsQuery.queryKey, MePrefs.parse({}));
  client.setQueryData(issueRefQuery(SLUG, 7).queryKey, issue("Old title"));
  return client;
}

function ref(commentId?: number) {
  return (
    <IssueLink
      slug={SLUG}
      number={7}
      commentId={commentId}
      pageSlug={SLUG}
      fallbackHref={commentId === undefined ? ISSUE_HREF : COMMENT_HREF}
      fallbackChildren="original reference"
    />
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(ui: ReactElement, client: QueryClient) {
  const view = renderWithProviders(ui, client);
  // RouterProvider's first render is asynchronous; flush its microtasks and
  // the issue lookup batch's zero-delay timer without advancing wall time.
  await advance(0);
  return view;
}

type View = { container: HTMLElement };
function rich(view: View): HTMLAnchorElement | null {
  return view.container.querySelector("a[data-issue-link='7']");
}
function expectRich(view: View, title: string, href = ISSUE_HREF) {
  const link = rich(view);
  expect(link?.getAttribute("href")).toBe(href);
  expect(link?.getAttribute("title")).toContain(title);
  expect(link?.textContent).toContain(title);
  expect(link?.textContent).toContain("T-7");
}
function expectPlain(view: View, href = ISSUE_HREF) {
  expect(rich(view)).toBeNull();
  const link = view.container.querySelector("a");
  expect(link?.getAttribute("href")).toBe(href);
  expect(link?.textContent).toBe("original reference");
  expect(link?.getAttribute("title")).toBeNull();
  expect(link?.getAttribute("data-comment-link")).toBeNull();
  expect(view.container.textContent).not.toContain("Old title");
  expect(view.container.querySelector("[data-comment-ref]")).toBeNull();
  expect(view.container.querySelector("[data-comment-author]")).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
  // Interval fetches are focus-gated by QueryClient. Happy DOM's focus
  // state is not a reliable stand-in for an active browser tab.
  focusManager.setFocused(true);
});
afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Regression shape before active revalidation: staleTime=60s only marks a
 * query stale; it never sends a request at the deadline. Before the pending
 * guard, IssueLink also keeps painting the old title/author until data is null.
 * Every case below checks the actual anchor and metadata, not just the cache.
 */
describe("visible reference metadata validity", () => {
  it("revalidates an active issue at 60s, hides old decoration in flight, then restores the new title", async () => {
    const request = deferred<IssueListPage>();
    const list = vi.spyOn(api, "listIssues").mockReturnValue(request.promise);
    const client = seeded();
    const view = await mount(ref(), client);
    expectRich(view, "Old title");

    await advance(59_999);
    expect(list).not.toHaveBeenCalled();
    expectRich(view, "Old title");
    await advance(1);
    expect(
      client.getQueryState(issueRefQuery(SLUG, 7).queryKey)?.fetchStatus,
    ).toBe("fetching");
    await advance(1); // the batch's zero-delay timer was scheduled at the deadline
    expect(list).toHaveBeenCalledTimes(1);
    expectPlain(view);

    await act(async () => request.resolve(page("New title")));
    await advance(0);
    expectRich(view, "New title");
    expect(view.container.textContent).not.toContain("Old title");
  });

  it("schedules a prewarmed result from its remaining freshness", () => {
    const client = seeded();
    const query = client.getQueryCache().find<ResolvedIssueRef | null>({
      queryKey: issueRefQuery(SLUG, 7).queryKey,
    });
    vi.setSystemTime(Date.now() + 59_000);
    const interval = issueRefQuery(SLUG, 7).refetchInterval;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function" || query === undefined) {
      throw new Error("active reference interval unavailable");
    }
    expect(interval(query)).toBe(1_000);
  });

  it("revalidates a comment author at 60s without displaying mixed old issue/comment metadata", async () => {
    const request = deferred<TimelineComment>();
    const getComment = vi
      .spyOn(api, "getComment")
      .mockReturnValue(request.promise);
    // The issue has the same 60s deadline. Let its independent refresh
    // complete so this case specifically holds the comment author in flight.
    vi.spyOn(api, "listIssues").mockResolvedValue(page("Old title"));
    const client = seeded();
    client.setQueryData<ResolvedCommentRef | null>(
      commentRefQuery(SLUG, 7, 42).queryKey,
      () => ({
        ...comment(),
        at: { slug: SLUG, number: 7, commentId: 42 },
      }),
    );
    const view = await mount(ref(42), client);
    expectRich(view, "Old title", COMMENT_HREF);
    expect(
      [...(rich(view)?.querySelectorAll("[data-ref-part]") ?? [])]
        .map((part) => part.textContent)
        .join(""),
    ).toBe("T-7#comment-42");
    expect(
      rich(view)?.querySelector("[data-comment-author]")?.textContent,
    ).toBe(" by Alice");
    expect(rich(view)?.getAttribute("data-comment-link")).toBe("42");

    await advance(59_999);
    expect(getComment).not.toHaveBeenCalled();
    await advance(1);
    await advance(1);
    expect(getComment).toHaveBeenCalledTimes(1);
    expectPlain(view, COMMENT_HREF);

    await act(async () => request.resolve(comment(bob)));
    await advance(1);
    expect(
      client.getQueryData<ResolvedCommentRef>(
        commentRefQuery(SLUG, 7, 42).queryKey,
      )?.author.login,
    ).toBe("bob");
  });
  it("removes a confirmed comment author after a missing reply or transient error", async () => {
    const client = seeded();
    client.setQueryData<ResolvedCommentRef | null>(
      commentRefQuery(SLUG, 7, 42).queryKey,
      () => ({
        ...comment(),
        at: { slug: SLUG, number: 7, commentId: 42 },
      }),
    );
    const getComment = vi.spyOn(api, "getComment");
    const view = await mount(ref(42), client);
    expect(
      [...(rich(view)?.querySelectorAll("[data-ref-part]") ?? [])]
        .map((part) => part.textContent)
        .join(""),
    ).toBe("T-7#comment-42");
    expect(
      rich(view)?.querySelector("[data-comment-author]")?.textContent,
    ).toBe(" by Alice");

    const missing = deferred<TimelineComment>();
    getComment.mockReturnValueOnce(missing.promise);
    const first = invalidateIssueRefQueries(client, {
      slug: SLUG,
      issueNumber: 7,
      commentId: 42,
    });
    await advance(1);
    expectPlain(view, COMMENT_HREF);
    await act(async () => missing.reject({ status: 404 }));
    await first;
    expectPlain(view, COMMENT_HREF);

    getComment.mockResolvedValueOnce(comment(bob));
    const refresh = invalidateIssueRefQueries(client, {
      slug: SLUG,
      issueNumber: 7,
      commentId: 42,
    });
    await act(async () => {
      await refresh;
    });
    await advance(1);
    expect(
      [...(rich(view)?.querySelectorAll("[data-ref-part]") ?? [])]
        .map((part) => part.textContent)
        .join(""),
    ).toBe("T-7#comment-42");
    expect(
      rich(view)?.querySelector("[data-comment-author]")?.textContent,
    ).toBe(" by Bob");

    const failed = deferred<TimelineComment>();
    getComment.mockReturnValueOnce(failed.promise);
    const second = invalidateIssueRefQueries(client, {
      slug: SLUG,
      issueNumber: 7,
      commentId: 42,
    });
    await advance(1);
    expectPlain(view, COMMENT_HREF);
    await act(async () => failed.reject(new Error("offline")));
    await second;
    expectPlain(view, COMMENT_HREF);
    expect(view.container.textContent).not.toContain("by Bob");
  });

  it("does not paint stale decoration on the first frame after background/refocus", async () => {
    const request = deferred<IssueListPage>();
    const list = vi.spyOn(api, "listIssues").mockReturnValue(request.promise);
    const view = await mount(ref(), seeded());
    expectRich(view, "Old title");
    focusManager.setFocused(false);
    await advance(60_002);
    const callsWhileBackgrounded = list.mock.calls.length;
    expectPlain(view); // stale even before a network reply or focus event
    await act(async () => focusManager.setFocused(true));
    await advance(1);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(
      callsWhileBackgrounded,
    );
    expectPlain(view);
    await act(async () => request.resolve(page("Focused title")));
  });
});

describe("account boundary", () => {
  it("clears a confirmed ref and discards an in-flight older reply on logout", async () => {
    const me: Me = {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human",
      avatar_url: null,
      owner: null,
      email: null,
      is_instance_admin: true,
      created_at: "2026-01-01T00:00:00Z",
    };
    const client = seeded();
    client.setQueryData(["auth-mode"], { mode: "single" });
    vi.spyOn(api, "logout").mockResolvedValue(undefined);
    const request = deferred<IssueListPage>();
    vi.spyOn(api, "listIssues").mockReturnValue(request.promise);
    const view = await mount(<AppShell me={me}>{ref()}</AppShell>, client);
    expectRich(view, "Old title");

    const oldRefresh = invalidateIssueRefQueries(client, {
      slug: SLUG,
      issueNumber: 7,
    });
    await advance(1);
    expectPlain({
      container: view.container.querySelector("main") as HTMLElement,
    });
    const trigger = screen.getByText("User").closest("button");
    expect(trigger).not.toBeNull();
    fireEvent.pointerDown(trigger as HTMLElement, {
      button: 0,
      pointerType: "mouse",
    });
    await advance(0);
    fireEvent.click(screen.getByText("Log out"));
    await advance(0);
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(
      client.getQueryData(issueRefQuery(SLUG, 7).queryKey),
    ).toBeUndefined();

    await act(async () => request.resolve(page("Previous account title")));
    await oldRefresh;
    expect(
      client.getQueryData(issueRefQuery(SLUG, 7).queryKey),
    ).toBeUndefined();
    expect(view.container.textContent).not.toContain("Previous account title");
    expect(rich(view)).toBeNull();
  });
});
