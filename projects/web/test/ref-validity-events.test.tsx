import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  type IssueListItem,
  type IssueListPage,
  MePrefs,
  type TimelineComment,
  type TimelineEvent,
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
import {
  api,
  labelsQuery,
  membersQuery,
  projectsQuery,
  statusesQuery,
} from "../src/api/queries.ts";
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
import { EventRow } from "../src/components/timeline/event-row.tsx";
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

function expectCommentIdentity(
  anchor: Element,
  spelled: string,
  author: string,
) {
  const tokens = anchor.querySelectorAll("[data-comment-ref]");
  expect(tokens).toHaveLength(1);
  const token = tokens[0] as HTMLElement;
  const parts = [...token.querySelectorAll("[data-ref-part]")];
  expect(parts.map((part) => part.textContent).join("")).toBe(spelled);
  for (const part of parts) {
    expect(
      part.closest("[hidden], [aria-hidden='true'], .hidden, .sr-only"),
    ).toBeNull();
    expect(getComputedStyle(part).display).not.toBe("none");
    expect(getComputedStyle(part).visibility).not.toBe("hidden");
    expect(getComputedStyle(part).visibility).not.toBe("collapse");
  }
  expect(
    token.closest("[hidden], [aria-hidden='true'], .hidden, .sr-only"),
  ).toBeNull();
  expect(getComputedStyle(token).display).not.toBe("none");
  expect(getComputedStyle(token).visibility).not.toBe("hidden");
  const authors = anchor.querySelectorAll("[data-comment-author]");
  expect(authors).toHaveLength(1);
  expect(authors[0]?.textContent).toBe(` by ${author}`);
  expect(token.contains(authors[0] ?? null)).toBe(false);
  expect(authors[0]?.contains(token)).toBe(false);
  expect([...anchor.querySelectorAll("[data-ref-part]")]).toEqual(parts);
  expect(anchor.textContent?.match(/#comment-\d+/g)).toEqual([
    spelled.match(/#comment-\d+$/)?.[0],
  ]);
  expect(anchor.textContent).not.toContain("comment by");
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
  expect(container.querySelector("[data-comment-ref]")).toBeNull();
  expect(container.querySelector("[data-comment-author]")).toBeNull();
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
      expectCommentIdentity(rich, "destination/T-55#comment-8", "Alice");
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
      const anchor = view.container.querySelector("a[data-comment-link='8']");
      expect(anchor).not.toBeNull();
      expectCommentIdentity(
        anchor as HTMLAnchorElement,
        "destination/T-55#comment-8",
        "Alice",
      );
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
      expect(anchor).not.toBeNull();
      expectCommentIdentity(
        anchor as HTMLAnchorElement,
        "destination/T-55#comment-8",
        "Bob",
      );
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

describe("referenced EventRow comment identity", () => {
  it.each(["before", "after"] as const)(
    "shows the final comment identity with %s placement without body chip styling",
    async (placement) => {
      const client = seeded();
      client.setQueryData(
        prefsQuery.queryKey,
        MePrefs.parse({
          ref_placement_reference: placement,
          boxed_ref_links: true,
          truncate_ref_title: true,
        }),
      );
      client.setQueryData(labelsQuery(SOURCE).queryKey, []);
      client.setQueryData(statusesQuery(SOURCE).queryKey, [issue(12).status]);
      client.setQueryData(membersQuery(SOURCE).queryKey, []);
      const issueKey = issueRefQuery(SOURCE, 12).queryKey;
      const commentKey = commentRefQuery(SOURCE, 12, 7).queryKey;
      const updatedAt = Date.now();
      client.setQueryData<ResolvedIssueRef>(
        issueKey,
        {
          ...issue(55, "Final source title"),
          at: { slug: DESTINATION, number: 55 },
        },
        { updatedAt },
      );
      client.setQueryData<ResolvedCommentRef>(
        commentKey,
        {
          ...comment(bob),
          at: { slug: DESTINATION, number: 55, commentId: 8 },
        },
        { updatedAt },
      );
      const event: TimelineEvent = {
        type: "event",
        id: 91,
        event_type: "referenced",
        actor: alice,
        agent_context: null,
        payload: {
          by_project: SOURCE,
          by_project_id: 1,
          by_issue: 12,
          by_comment: 7,
        },
        created_at: "2026-09-01T00:00:00Z",
      };
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const view = renderWithProviders(
        <EventRow event={event} slug={SOURCE} />,
        client,
      );
      const anchor = await waitFor(() => {
        const link = view.container.querySelector("a[data-comment-link='8']");
        expect(link).not.toBeNull();
        return link as HTMLAnchorElement;
      });
      for (const key of [issueKey, commentKey]) {
        expect(client.getQueryState(key)).toMatchObject({
          status: "success",
          fetchStatus: "idle",
          isInvalidated: false,
          dataUpdatedAt: updatedAt,
        });
        expect(Date.now() - updatedAt).toBeLessThan(60_000);
      }
      expectCommentIdentity(anchor, "destination/T-55#comment-8", "Bob");
      expect(anchor.getAttribute("data-issue-link")).toBe("55");
      expect(anchor.getAttribute("data-issue-project")).toBe(DESTINATION);
      expect(anchor.getAttribute("href")).toBe(
        "/projects/destination/issues/55#comment-8",
      );
      expect(anchor.textContent).toBe(
        placement === "before"
          ? "destination/T-55 Final source title · #comment-8 by Bob"
          : "Final source title · destination/T-55#comment-8 by Bob",
      );
      expect(anchor.className).toBe("font-medium hover:underline");
      expect(
        anchor.querySelector(".inline-flex, .border, .truncate, .flex-none"),
      ).toBeNull();
      expect(anchor.querySelector(".comment-reference-body")).toBeNull();
      expect(anchor.querySelector("svg")?.getAttribute("class")).toContain(
        "mr-0.5 inline size-3.5 align-middle",
      );
      const card = await hover(anchor);
      expect(card.textContent).toContain("Fresh located body");
      expect(card.textContent).toContain("Bob");
      expect(card.textContent).not.toContain("Old authorized body");
      expect(
        card.querySelector(
          'a[href="/projects/destination/issues/55#comment-8"]',
        ),
      ).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
