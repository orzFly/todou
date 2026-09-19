import {
  focusManager,
  onlineManager,
  type QueryClient,
} from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import {
  type CommentLocation,
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
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
  type ResolvedCommentRef,
} from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { api, projectsQuery } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import {
  IssueLink,
  MarkdownLink,
} from "../src/components/shared/issue-link.tsx";
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
const comment = (): TimelineComment => ({
  type: "comment",
  id: 42,
  author: alice,
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
const location = (): CommentLocation => ({
  issue_number: 7,
  issue_ref: "T-7",
  comment: comment(),
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

function configured(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery(SLUG).queryKey, config);
  client.setQueryData(prefsQuery.queryKey, MePrefs.parse({}));
  client.setQueryData(projectsQuery.queryKey, []);
  // Keep unrelated directory/preferences requests out of these request counts.
  for (const query of [referenceConfigQuery(SLUG), prefsQuery, projectsQuery]) {
    client.setQueryDefaults(query.queryKey, {
      gcTime: Infinity,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
  }
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
  // Flush the asynchronous router render and the issue batch timer.
  await advance(1);
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
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
});
afterEach(() => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("visible reference session cache", () => {
  it.each(["issue", "full comment", "bare comment"] as const)(
    "resolves a %s once and preserves its anchor through ten minutes, focus, reconnect and remount",
    async (kind) => {
      const issueRequest = deferred<IssueListPage>();
      const commentRequest = deferred<TimelineComment>();
      const locationRequest = deferred<CommentLocation>();
      const list = vi
        .spyOn(api, "listIssues")
        .mockReturnValue(issueRequest.promise);
      const getComment = vi
        .spyOn(api, "getComment")
        .mockReturnValue(commentRequest.promise);
      const locate = vi
        .spyOn(api, "locateComment")
        .mockReturnValue(locationRequest.promise);
      const getIssue = vi.spyOn(api, "getIssue");
      const client = configured();
      const ui =
        kind === "bare comment" ? (
          <MarkdownLink
            slug={SLUG}
            href="#xref-comment-42"
            node={{ children: [{ type: "text", value: "#comment-42" }] }}
          >
            #comment-42
          </MarkdownLink>
        ) : (
          ref(kind === "issue" ? undefined : 42)
        );
      const view = await mount(ui, client);
      expect(rich(view)).toBeNull();
      if (kind === "bare comment") {
        expect(view.container.querySelector("a")).toBeNull();
        expect(view.container.textContent).toBe("#comment-42");
      } else {
        expectPlain(view, kind === "issue" ? ISSUE_HREF : COMMENT_HREF);
      }

      await act(async () => {
        issueRequest.resolve(page("Old title"));
        commentRequest.resolve(comment());
        locationRequest.resolve(location());
      });
      // Bare comments mount the issue observer after the location notification;
      // flush both that batch timer and its observer notification.
      await advance(5);
      const href = kind === "issue" ? ISSUE_HREF : COMMENT_HREF;
      expectRich(view, "Old title", href);
      const anchor = rich(view) as HTMLAnchorElement;
      const markup = anchor.outerHTML;
      const children = [...anchor.childNodes];
      if (kind !== "issue") {
        expect(anchor.querySelector("[data-comment-author]")?.textContent).toBe(
          " by Alice",
        );
      }
      const keys: Array<readonly unknown[]> = [issueRefQuery(SLUG, 7).queryKey];
      if (kind !== "issue") keys.push(commentRefQuery(SLUG, 7, 42).queryKey);
      if (kind === "bare comment")
        keys.push(commentLocationQuery(SLUG, 42).queryKey);
      const timestamps = keys.map(
        (key) => client.getQueryState(key)?.dataUpdatedAt,
      );
      if (kind === "bare comment") expect(timestamps[1]).toBe(timestamps[2]);
      const expectRequests = () => {
        expect(list).toHaveBeenCalledTimes(1);
        expect(getComment).toHaveBeenCalledTimes(
          kind === "full comment" ? 1 : 0,
        );
        expect(locate).toHaveBeenCalledTimes(kind === "bare comment" ? 1 : 0);
        expect(getIssue).not.toHaveBeenCalled();
      };
      const expectSameAnchor = () => {
        expect(rich(view)).toBe(anchor);
        expect(anchor.outerHTML).toBe(markup);
        expect(anchor.childNodes.length).toBe(children.length);
        children.forEach((child, index) => {
          expect(anchor.childNodes[index]).toBe(child);
        });
        expectRequests();
      };
      expectRequests();
      await advance(10 * 60_000);
      expectSameAnchor();
      await act(async () => {
        focusManager.setFocused(false);
        onlineManager.setOnline(false);
      });
      await advance(10 * 60_000);
      expectSameAnchor();
      await act(async () => {
        focusManager.setFocused(true);
        onlineManager.setOnline(true);
      });
      await advance(1);
      expectSameAnchor();
      await act(async () => {
        await Promise.all(
          keys.map((queryKey) => client.invalidateQueries({ queryKey })),
        );
      });
      await advance(1);
      expectSameAnchor();

      view.unmount();
      await advance(10 * 60_000);
      const remounted = await mount(ui, client);
      expectRich(remounted, "Old title", href);
      // A remount creates new DOM; its address, decoration and cache timestamps stay identical.
      expect(rich(remounted)?.outerHTML).toBe(markup);
      expect(
        keys.map((key) => client.getQueryState(key)?.dataUpdatedAt),
      ).toEqual(timestamps);
      expectRequests();
      remounted.unmount();
      client.clear();
    },
  );

  it.each([403, 404, 410, "offline"])(
    "keeps an initially unreadable comment ordinary (%s)",
    async (failure) => {
      const client = configured();
      client.setQueryData(issueRefQuery(SLUG, 7).queryKey, issue("Old title"));
      const request = deferred<TimelineComment>();
      const getComment = vi
        .spyOn(api, "getComment")
        .mockReturnValue(request.promise);
      const view = await mount(ref(42), client);
      expectPlain(view, COMMENT_HREF);
      await act(async () =>
        request.reject(
          failure === "offline" ? new Error("offline") : { status: failure },
        ),
      );
      await advance(1);
      expectPlain(view, COMMENT_HREF);
      expect(getComment).toHaveBeenCalledTimes(1);
      view.unmount();
      client.clear();
    },
  );

  it.each([
    "missing",
    "deleted",
    "different parent",
    "different project",
    "different comment",
  ])("rejects %s metadata even when cached for the session", async (kind) => {
    const client = configured();
    client.setQueryData(
      issueRefQuery(SLUG, 7).queryKey,
      kind === "missing"
        ? null
        : {
            ...issue("Old title"),
            deleted_at: kind === "deleted" ? "2026-09-18T00:00:00Z" : null,
          },
    );
    client.setQueryData<ResolvedCommentRef>(
      commentRefQuery(SLUG, 7, 42).queryKey,
      {
        ...comment(),
        at: {
          slug: kind === "different project" ? "other" : SLUG,
          number: kind === "different parent" ? 8 : 7,
          commentId: kind === "different comment" ? 99 : 42,
        },
      },
    );
    const view = await mount(ref(42), client);
    expectPlain(view, COMMENT_HREF);
    view.unmount();
    client.clear();
  });
});

describe("account boundary", () => {
  it("clears all three session caches and discards an in-flight older reply on logout", async () => {
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
    const client = configured();
    const keys = [
      issueRefQuery(SLUG, 7).queryKey,
      commentRefQuery(SLUG, 7, 42).queryKey,
      commentLocationQuery(SLUG, 42).queryKey,
      issueRefQuery(SLUG, 8).queryKey,
    ] as const;
    client.setQueryData(keys[0], issue("Old title"));
    client.setQueryData<ResolvedCommentRef>(keys[1], {
      ...comment(),
      at: { slug: SLUG, number: 7, commentId: 42 },
    });
    client.setQueryData(keys[2], location());
    client.setQueryData(["auth-mode"], { mode: "single" });
    vi.spyOn(api, "logout").mockResolvedValue(undefined);
    const request = deferred<IssueListPage>();
    const list = vi.spyOn(api, "listIssues").mockReturnValue(request.promise);
    const view = await mount(<AppShell me={me}>{ref(42)}</AppShell>, client);
    expectRich(view, "Old title", COMMENT_HREF);
    const oldRequest = client
      .fetchQuery(issueRefQuery(SLUG, 8))
      .catch(() => undefined);
    await advance(1);
    expect(list).toHaveBeenCalledTimes(1);
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
    for (const key of keys) expect(client.getQueryData(key)).toBeUndefined();

    await act(async () =>
      request.resolve({
        items: [{ ...issue("Previous account title"), id: 8, number: 8 }],
        next_cursor: null,
      }),
    );
    await oldRequest;
    for (const key of keys) expect(client.getQueryData(key)).toBeUndefined();
    expect(view.container.textContent).not.toContain("Previous account title");
    expect(rich(view)).toBeNull();
    view.unmount();
    client.clear();
  });
});
