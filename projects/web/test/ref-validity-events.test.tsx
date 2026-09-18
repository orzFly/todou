import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  type IssueListItem,
  type IssueListPage,
  MePrefs,
  type TimelineComment,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
  type LocatedComment,
  type ResolvedCommentRef,
  type ResolvedIssueRef,
} from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { api, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import {
  applyInvalidation,
  invalidationsFor,
} from "../src/api/useUserEvents.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SOURCE = "historical";
const DESTINATION = "destination";
const OLD_TITLE = "Previously authorized title";
const originalHref = "/projects/historical/issues/12#comment-7";
const alice = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const bob = { ...alice, id: 2, login: "bob", display_name: "Bob" };

const issue = (number: number, title = OLD_TITLE): IssueListItem => ({
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
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
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
  id: 8,
  author,
  body: author === alice ? "Old authorized body" : "Fresh located body",
  created_at: "2026-09-01T00:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  component: null,
  agent_context: null,
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

const clients: QueryClient[] = [];
function seeded() {
  const client = testQueryClient();
  clients.push(client);
  client.setQueryData(prefsQuery.queryKey, MePrefs.parse({}));
  client.setQueryData(referenceDirectoryQuery.queryKey, () => ({
    entries: [],
    contested: [],
  }));
  client.setQueryData(
    projectsQuery.queryKey,
    [SOURCE, DESTINATION].map((slug, index) => ({
      id: index + 1,
      slug,
      name: slug,
      description: "",
      created_at: "2026-09-01T00:00:00Z",
    })),
  );
  for (const slug of [SOURCE, DESTINATION]) {
    client.setQueryData(referenceConfigQuery(slug).queryKey, {
      format: { prefix: "T", history: [] },
      autolinks: [],
    });
  }
  return client;
}

function expectOrdinary(container: HTMLElement, href: string) {
  const anchor = container.querySelector("a");
  expect(anchor?.getAttribute("href")).toBe(href);
  expect(anchor?.querySelector("strong")?.textContent).toBe("original label");
  expect(anchor?.textContent).toBe("original label");
  for (const attribute of [
    "title",
    "data-issue-link",
    "data-comment-link",
    "data-state",
    "aria-haspopup",
  ]) {
    expect(anchor?.getAttribute(attribute)).toBeNull();
  }
  expect(anchor?.querySelector("svg")).toBeNull();
  expect(container.textContent).not.toContain(OLD_TITLE);
  expect(container.textContent).not.toContain("comment by Alice");
  expect(document.querySelector("[data-slot='hover-card-content']")).toBeNull();
}

async function hover(anchor: Element) {
  fireEvent.pointerOver(anchor, { pointerType: "mouse", bubbles: true });
  return waitFor(() => {
    const card = document.querySelector("[data-slot='hover-card-content']");
    expect(card).not.toBeNull();
    return card as HTMLElement;
  });
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe("reference validity through SSE invalidations", () => {
  it.each([403, 404])(
    "ignores an initial authorized issue response arriving after a membership refresh returned %i",
    async (status) => {
      const old = deferred<IssueListPage>();
      const refreshed = deferred<IssueListPage>();
      const list = vi
        .spyOn(api, "listIssues")
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(refreshed.promise);
      const getIssue = vi.spyOn(api, "getIssue").mockRejectedValue({ status });
      const client = seeded();
      const href = "/projects/historical/issues/12";
      const view = renderWithProviders(
        <div>
          <section data-testid="markdown">
            <MarkdownView slug={SOURCE}>
              {"[**original label**](/projects/historical/issues/12)"}
            </MarkdownView>
          </section>
          <section data-testid="direct">
            <IssueLink
              slug={SOURCE}
              number={12}
              pageSlug={SOURCE}
              fallbackHref={href}
              fallbackChildren={<strong>original label</strong>}
              inBody
            />
          </section>
        </div>,
        client,
      );
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      const key = issueRefQuery(SOURCE, 12).queryKey;
      expect(client.getQueryState(key)?.status).toBe("pending");
      expect(client.getQueryState(key)?.data).toBeUndefined();
      const expectBothOrdinary = () => {
        expectOrdinary(view.getByTestId("markdown"), href);
        expectOrdinary(view.getByTestId("direct"), href);
      };
      expectBothOrdinary();

      act(() => {
        for (const invalidation of invalidationsFor(
          { entity: "member", id: 1, action: "deleted" },
          SOURCE,
        )) {
          applyInvalidation(client, invalidation);
        }
      });
      // The first query has no cached data: invalidateQueries alone would
      // reuse its pending promise instead of starting a new generation.
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expectBothOrdinary();
      await act(async () =>
        refreshed.resolve({ items: [], next_cursor: null }),
      );
      await waitFor(() => expect(client.getQueryData(key)).toBeNull());
      expect(getIssue).toHaveBeenCalledExactlyOnceWith(SOURCE, 12);
      expectBothOrdinary();

      await act(async () => {
        old.resolve({ items: [issue(12)], next_cursor: null });
        await old.promise;
        // Let the batcher's continuations and observer notifications finish
        // before asserting that the cancelled generation stayed discarded.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(client.getQueryData(key)).toBeNull();
      expect(client.getQueryState(key)?.fetchStatus).toBe("idle");
      expect(list).toHaveBeenCalledTimes(2);
      expectBothOrdinary();
    },
  );

  it.each(["comment", "timeline"] as const)(
    "withdraws a migrated comment under its historical key on a destination %s event",
    async (entity) => {
      const request = deferred<TimelineComment>();
      const getComment = vi
        .spyOn(api, "getComment")
        .mockReturnValue(request.promise);
      const client = seeded();
      client.setQueryData<ResolvedIssueRef | null>(
        issueRefQuery(SOURCE, 12).queryKey,
        () => ({
          ...issue(55),
          at: { slug: DESTINATION, number: 55 },
        }),
      );
      const key = commentRefQuery(SOURCE, 12, 7).queryKey;
      client.setQueryData<ResolvedCommentRef>(key, {
        ...comment(),
        at: { slug: DESTINATION, number: 55, commentId: 8 },
      });
      const view = renderWithProviders(
        <MarkdownView slug={SOURCE}>
          {"[**original label**](/projects/historical/issues/12#comment-7)"}
        </MarkdownView>,
        client,
      );
      const rich = await waitFor(() => {
        const anchor = view.container.querySelector("a[data-comment-link='8']");
        expect(anchor).not.toBeNull();
        return anchor as HTMLAnchorElement;
      });
      expect(rich.getAttribute("href")).toBe(
        "/projects/destination/issues/55#comment-8",
      );
      expect(rich.textContent).toContain("comment by Alice");
      expect((await hover(rich)).textContent).toContain("Old authorized body");
      expect(getComment).not.toHaveBeenCalled();

      act(() => {
        for (const invalidation of invalidationsFor(
          { entity, id: 8, action: "deleted", issue_number: 55 },
          DESTINATION,
        )) {
          applyInvalidation(client, invalidation);
        }
      });
      await waitFor(() => {
        expect(getComment).toHaveBeenCalledExactlyOnceWith(SOURCE, 12, 7);
        expect(client.getQueryState(key)?.fetchStatus).toBe("fetching");
        expectOrdinary(view.container, originalHref);
      });
      // The stored address still uses comment 7; a destination-only key
      // invalidation would leave both its rich link and open hover intact.
      await act(async () => request.reject({ status: 404 }));
      await waitFor(() => expect(client.getQueryData(key)).toBeNull());
      expectOrdinary(view.container, originalHref);
      expect(getComment).toHaveBeenCalledTimes(1);
    },
  );

  it("uses a refreshed bare location's full comment despite an already-stale target cache, preserving timestamps", async () => {
    const now = Date.parse("2026-09-18T12:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const request = deferred<LocatedComment>();
    const locate = vi
      .spyOn(api, "locateComment")
      .mockReturnValue(request.promise);
    const getComment = vi.spyOn(api, "getComment");
    const client = seeded();
    client.setQueryData(
      issueRefQuery(DESTINATION, 55).queryKey,
      issue(55, "Located parent"),
    );
    const targetKey = commentRefQuery(DESTINATION, 55, 8).queryKey;
    const staleTarget: ResolvedCommentRef = {
      ...comment(),
      at: { slug: DESTINATION, number: 55, commentId: 8 },
    };
    const staleUpdatedAt = now - 60_001;
    client.setQueryData(targetKey, staleTarget, { updatedAt: staleUpdatedAt });
    const locationKey = commentLocationQuery(SOURCE, 7).queryKey;
    client.setQueryData<LocatedComment>(
      locationKey,
      {
        slug: DESTINATION,
        issue_number: 55,
        issue_ref: "destination#55",
        comment: comment(),
      },
      { updatedAt: now - 1_000 },
    );
    const view = renderWithProviders(
      <MarkdownView slug={SOURCE} preview>
        {"#comment-7"}
      </MarkdownView>,
      client,
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("a[data-comment-link='8']")?.textContent,
      ).toContain("comment by Alice");
    });
    expect(getComment).not.toHaveBeenCalled();

    act(() => {
      for (const invalidation of invalidationsFor(
        { entity: "comment", id: 8, action: "updated", issue_number: 55 },
        DESTINATION,
      )) {
        applyInvalidation(client, invalidation);
      }
    });
    await waitFor(() => {
      expect(locate).toHaveBeenCalledExactlyOnceWith(SOURCE, 7);
      expect(view.container.querySelector("a")).toBeNull();
      expect(view.container.textContent).toContain("#comment-7");
    });
    const freshLocation: LocatedComment = {
      slug: DESTINATION,
      issue_number: 55,
      issue_ref: "destination#55",
      comment: comment(bob),
    };
    await act(async () => request.resolve(freshLocation));
    const rich = await waitFor(() => {
      const anchor = view.container.querySelector("a[data-comment-link='8']");
      expect(anchor?.textContent).toContain("comment by Bob");
      return anchor as HTMLAnchorElement;
    });
    expect(rich.getAttribute("href")).toBe(
      "/projects/destination/issues/55#comment-8",
    );
    expect(rich.getAttribute("data-issue-link")).toBe("55");
    expect(rich.textContent).toContain("Located parent");
    expect(rich.textContent).not.toContain("Alice");
    const locationUpdatedAt = client.getQueryState(locationKey)?.dataUpdatedAt;
    expect(locationUpdatedAt).toBe(now);

    clock.mockReturnValue(now + 1_000);
    const card = await hover(rich);
    expect(card.textContent).toContain("Bob");
    expect(card.textContent).toContain("Fresh located body");
    expect(card.textContent).not.toContain("Old authorized body");
    expect(card.textContent).not.toContain("Alice");
    expect(locate).toHaveBeenCalledTimes(1);
    expect(getComment).not.toHaveBeenCalled();
    expect(client.getQueryData(locationKey)).toEqual(freshLocation);
    expect(client.getQueryState(locationKey)?.dataUpdatedAt).toBe(
      locationUpdatedAt,
    );
    expect(client.getQueryData(targetKey)).toEqual(staleTarget);
    expect(client.getQueryState(targetKey)?.dataUpdatedAt).toBe(staleUpdatedAt);
  });
});
