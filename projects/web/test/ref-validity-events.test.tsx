import { type QueryClient, QueryObserver } from "@tanstack/react-query";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  type IssueListItem,
  type IssueListPage,
  MePrefs,
  MovedError,
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
import { issueQuery } from "../src/api/issues.ts";
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
  searchCommentLocationQuery,
  searchCommentRefQuery,
  searchIssueRefQuery,
} from "../src/api/search-refs.ts";
import {
  applyInvalidation,
  invalidationsFor,
  reconnectInvalidations,
} from "../src/api/useUserEvents.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SOURCE = "historical";
const DESTINATION = "destination";
const OLD_TITLE = "Previously authorized title";
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
  for (const slug of [SOURCE, DESTINATION, "999"]) {
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

const backgroundEvents = [
  "comment",
  "timeline",
  "issue",
  "member",
  "project",
  "reconnect",
] as const;

async function backgroundEvent(
  client: QueryClient,
  entity: (typeof backgroundEvents)[number],
  slug = DESTINATION,
  issueNumber = 55,
) {
  await act(async () => {
    const invalidations =
      entity === "reconnect"
        ? reconnectInvalidations().map((key) => ({
            key,
            scope: "refetch" as const,
          }))
        : invalidationsFor(
            { entity, id: 8, action: "updated", issue_number: issueNumber },
            slug,
          );
    for (const invalidation of invalidations) {
      applyInvalidation(client, invalidation);
    }
    // Let cancellation, batched requests and observer notifications run before
    // checking a negative request-count or DOM-identity assertion.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
}

function mockDirectories(client: QueryClient) {
  vi.spyOn(api, "listProjects").mockResolvedValue(
    client.getQueryData(projectsQuery.queryKey) ?? [],
  );
  vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
    format: { prefix: "T", history: [] },
    autolinks: [],
  });
  vi.spyOn(api, "getReferenceDirectory").mockResolvedValue({
    entries: [],
    contested: [],
  });
  vi.spyOn(api, "getMyPrefs").mockResolvedValue(MePrefs.parse({}));
}

function unchangedReference(
  container: HTMLElement,
  anchor: HTMLAnchorElement,
  card: HTMLElement,
) {
  const href = anchor.getAttribute("href");
  const linkHtml = anchor.innerHTML;
  const hoverHtml = card.innerHTML;
  const linkChildren = [...anchor.querySelectorAll("*")];
  const hoverChildren = [...card.querySelectorAll("*")];
  return () => {
    expect(container.querySelector("a[data-issue-link]")).toBe(anchor);
    expect(anchor.isConnected).toBe(true);
    expect(anchor.getAttribute("href")).toBe(href);
    expect(anchor.innerHTML).toBe(linkHtml);
    expect(document.querySelector("[data-slot='hover-card-content']")).toBe(
      card,
    );
    expect(card.innerHTML).toBe(hoverHtml);
    for (const [root, children] of [
      [anchor, linkChildren],
      [card, hoverChildren],
    ] as const) {
      const current = [...root.querySelectorAll("*")];
      expect(current).toHaveLength(children.length);
      current.forEach((node, index) => {
        expect(node).toBe(children[index]);
      });
    }
  };
}

const unsubscribeSearch: (() => void)[] = [];

afterEach(() => {
  cleanup();
  for (const unsubscribe of unsubscribeSearch.splice(0)) unsubscribe();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe("initial display reference resolution", () => {
  describe.each([SOURCE, "999"])("project address %s", (source) => {
    it.each([403, 404])(
      "keeps authored issue links ordinary when the first lookup returns %i",
      async (status) => {
        const response = deferred<IssueListPage>();
        const list = vi
          .spyOn(api, "listIssues")
          .mockReturnValue(response.promise);
        const getIssue = vi
          .spyOn(api, "getIssue")
          .mockRejectedValue({ status });
        const client = seeded();
        const href = `/projects/${source}/issues/12`;
        const view = renderWithProviders(
          <div>
            <section data-testid="markdown">
              <MarkdownView slug={SOURCE}>
                {`[**original label**](${href})`}
              </MarkdownView>
            </section>
            <section data-testid="direct">
              <IssueLink
                slug={source}
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
        await waitFor(() => {
          expectOrdinary(view.getByTestId("markdown"), href);
          expectOrdinary(view.getByTestId("direct"), href);
        });
        const anchors = ["markdown", "direct"].map((id) =>
          view.getByTestId(id).querySelector("a"),
        );
        const key = issueRefQuery(source, 12).queryKey;
        await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
        expect(client.getQueryState(key)?.status).toBe("pending");
        expect(client.getQueryData(key)).toBeUndefined();
        await act(async () => {
          if (status === 403) response.reject({ status });
          else response.resolve({ items: [], next_cursor: null });
        });
        await waitFor(() => expect(client.getQueryData(key)).toBeNull());
        expect(getIssue).toHaveBeenCalledExactlyOnceWith(source, 12);
        expect(list).toHaveBeenCalledTimes(1);
        for (const [index, id] of ["markdown", "direct"].entries()) {
          const section = view.getByTestId(id);
          expectOrdinary(section, href);
          expect(section.querySelector("a")).toBe(anchors[index]);
        }
      },
    );
  });

  it.each([403, 404])(
    "does not expose issue metadata when the first comment/location lookup returns %i",
    async (status) => {
      const list = vi
        .spyOn(api, "listIssues")
        .mockResolvedValue({ items: [issue(12)], next_cursor: null });
      const getComment = vi
        .spyOn(api, "getComment")
        .mockRejectedValue({ status });
      const locate = vi
        .spyOn(api, "locateComment")
        .mockRejectedValue({ status });
      const client = seeded();
      const href = "/projects/historical/issues/12#comment-7";
      const view = renderWithProviders(
        <div>
          <section data-testid="explicit">
            <MarkdownView slug={SOURCE}>
              {`[**original label**](${href})`}
            </MarkdownView>
          </section>
          <section data-testid="bare">
            <MarkdownView slug={SOURCE} preview>
              {"#comment-7"}
            </MarkdownView>
          </section>
        </div>,
        client,
      );
      await waitFor(() => {
        expect(client.getQueryData(issueRefQuery(SOURCE, 12).queryKey)).toEqual(
          issue(12),
        );
        expect(
          client.getQueryData(commentRefQuery(SOURCE, 12, 7).queryKey),
        ).toBeNull();
        expect(
          client.getQueryData(commentLocationQuery(SOURCE, 7).queryKey),
        ).toBeNull();
      });
      expectOrdinary(view.getByTestId("explicit"), href);
      expect(view.getByTestId("bare").textContent).toBe("#comment-7");
      expect(view.getByTestId("bare").querySelector("a")).toBeNull();
      expect(view.container.textContent).not.toContain(OLD_TITLE);
      expect(list).toHaveBeenCalledExactlyOnceWith(SOURCE, {
        numbers: [12],
        limit: 1,
      });
      expect(getComment).toHaveBeenCalledExactlyOnceWith(SOURCE, 12, 7);
      expect(locate).toHaveBeenCalledExactlyOnceWith(SOURCE, 7);
    },
  );
});

describe.each([SOURCE, "999"])(
  "static display references from project address %s",
  (source) => {
    it.each(["issue", "comment"] as const)(
      "retains a resolved migrated %s link and open hover through every background event",
      async (kind) => {
        let readable = true;
        const list = vi
          .spyOn(api, "listIssues")
          .mockResolvedValue({ items: [], next_cursor: null });
        const getIssue = vi
          .spyOn(api, "getIssue")
          .mockImplementation(async (slug) => {
            if (!readable) throw { status: 403 };
            if (slug === source) {
              throw new MovedError({ slug: DESTINATION, number: 55 });
            }
            return { ...issue(55), body: "Old authorized issue body" };
          });
        const getComment = vi
          .spyOn(api, "getComment")
          .mockImplementation(async (slug) => {
            if (!readable) throw { status: 404 };
            if (slug === source) {
              throw new MovedError({
                slug: DESTINATION,
                number: 55,
                comment_id: 8,
              });
            }
            return comment();
          });
        const locate = vi.spyOn(api, "locateComment");
        const client = seeded();
        mockDirectories(client);
        // getIssue serves both reference migration and the live detail body.
        // Count canonical body fetches separately: invalidation may reread the
        // body, but must never resolve the static reference metadata again.
        const bodyKey = issueQuery(DESTINATION, 55).queryKey;
        let bodyReads = 0;
        const unsubscribeBody = client.getQueryCache().subscribe((event) => {
          if (
            event.type === "updated" &&
            event.action.type === "fetch" &&
            event.query ===
              client.getQueryCache().find({ queryKey: bodyKey, exact: true })
          ) {
            bodyReads++;
          }
        });
        const href = `/projects/${source}/issues/12${
          kind === "comment" ? "#comment-7" : ""
        }`;
        const view = renderWithProviders(
          <MarkdownView slug={SOURCE}>
            {`[**original label**](${href})`}
          </MarkdownView>,
          client,
        );
        const anchor = await waitFor(() => {
          const link = view.container.querySelector("a[data-issue-link='55']");
          expect(link).not.toBeNull();
          return link as HTMLAnchorElement;
        });
        expect(anchor.getAttribute("href")).toBe(
          `/projects/destination/issues/55${
            kind === "comment" ? "#comment-8" : ""
          }`,
        );
        expect(anchor.textContent).toContain(OLD_TITLE);
        if (kind === "comment") {
          expectCommentIdentity(anchor, "destination/T-55#comment-8", "Alice");
        }
        const card = await hover(anchor);
        await waitFor(() =>
          expect(card.textContent).toContain(
            kind === "comment"
              ? "Old authorized body"
              : "Old authorized issue body",
          ),
        );
        expect(list).toHaveBeenCalledTimes(1);
        expect(getIssue).toHaveBeenCalledTimes(kind === "comment" ? 2 : 3);
        expect(bodyReads).toBe(kind === "comment" ? 0 : 1);
        expect(getIssue).toHaveBeenNthCalledWith(1, source, 12);
        expect(getIssue).toHaveBeenNthCalledWith(2, DESTINATION, 55);
        expect(getComment).toHaveBeenCalledTimes(kind === "comment" ? 2 : 0);
        if (kind === "comment") {
          expect(getComment).toHaveBeenNthCalledWith(1, source, 12, 7);
          expect(getComment).toHaveBeenNthCalledWith(2, DESTINATION, 55, 8);
        }
        expect(locate).not.toHaveBeenCalled();
        const unchanged = unchangedReference(view.container, anchor, card);
        const issueKey = issueRefQuery(source, 12).queryKey;
        const noteKey = commentRefQuery(source, 12, 7).queryKey;
        const issueData = client.getQueryData(issueKey);
        const noteData = client.getQueryData(noteKey);
        readable = false;
        // Also invalidate the historical keys directly: destination-scoped
        // SSE events alone cannot prove static behavior for migrated refs.
        await act(async () => {
          await client.invalidateQueries({ queryKey: issueKey });
          await client.invalidateQueries({ queryKey: noteKey });
        });

        for (const entity of backgroundEvents) {
          await backgroundEvent(client, entity);
          unchanged();
          expect(list).toHaveBeenCalledTimes(1);
          expect(getIssue).toHaveBeenCalledTimes(2 + bodyReads);
          expect(getComment).toHaveBeenCalledTimes(kind === "comment" ? 2 : 0);
          expect(locate).not.toHaveBeenCalled();
          expect(client.getQueryData(issueKey)).toBe(issueData);
          expect(client.getQueryData(noteKey)).toBe(noteData);
          expect(client.getQueryState(issueKey)?.fetchStatus).toBe("idle");
        }

        const hoverText = card.textContent;
        fireEvent.pointerOut(anchor, {
          pointerType: "mouse",
          bubbles: true,
          relatedTarget: document.body,
        });
        await waitFor(() =>
          expect(
            document.querySelector("[data-slot='hover-card-content']"),
          ).toBeNull(),
        );
        const reopened = await hover(anchor);
        expect(reopened.textContent).toBe(hoverText);
        expect(view.container.querySelector("a[data-issue-link='55']")).toBe(
          anchor,
        );
        expect(list).toHaveBeenCalledTimes(1);
        expect(getIssue).toHaveBeenCalledTimes(2 + bodyReads);
        expect(getComment).toHaveBeenCalledTimes(kind === "comment" ? 2 : 0);
        expect(locate).not.toHaveBeenCalled();
        unsubscribeBody();
      },
    );
  },
);

describe("static located comment references", () => {
  it("keeps the initial full location, its timestamps and DOM through background events despite an older target cache", async () => {
    const now = Date.parse("2026-09-18T12:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const location: LocatedComment = {
      slug: DESTINATION,
      issue_number: 55,
      issue_ref: "destination#55",
      comment: comment(bob),
    };
    const locate = vi.spyOn(api, "locateComment").mockResolvedValue(location);
    const getComment = vi.spyOn(api, "getComment");
    const list = vi.spyOn(api, "listIssues").mockResolvedValue({
      items: [issue(55, "Located parent")],
      next_cursor: null,
    });
    const getIssue = vi.spyOn(api, "getIssue");
    const client = seeded();
    mockDirectories(client);
    const targetKey = commentRefQuery(DESTINATION, 55, 8).queryKey;
    const staleTarget: ResolvedCommentRef = {
      ...comment(),
      at: { slug: DESTINATION, number: 55, commentId: 8 },
    };
    const staleUpdatedAt = now - 60_001;
    client.setQueryData(targetKey, staleTarget, { updatedAt: staleUpdatedAt });
    const locationKey = commentLocationQuery(SOURCE, 7).queryKey;
    const view = renderWithProviders(
      <MarkdownView slug={SOURCE} preview>
        {"#comment-7"}
      </MarkdownView>,
      client,
    );
    const anchor = await waitFor(() => {
      const link = view.container.querySelector("a[data-comment-link='8']");
      expect(link).not.toBeNull();
      return link as HTMLAnchorElement;
    });
    expectCommentIdentity(anchor, "destination/T-55#comment-8", "Bob");
    expect(anchor.getAttribute("href")).toBe(
      "/projects/destination/issues/55#comment-8",
    );
    expect(anchor.getAttribute("data-issue-link")).toBe("55");
    expect(anchor.textContent).toContain("Located parent");
    expect(anchor.textContent).not.toContain("Alice");
    expect(client.getQueryState(locationKey)?.dataUpdatedAt).toBe(now);
    const card = await hover(anchor);
    expect(card.textContent).toContain("Fresh located body");
    expect(card.textContent).toContain("Bob");
    expect(card.textContent).not.toContain("Old authorized body");
    expect(card.textContent).not.toContain("Alice");
    const unchanged = unchangedReference(view.container, anchor, card);
    const locationData = client.getQueryData(locationKey);
    locate.mockRejectedValue({ status: 404 });
    clock.mockReturnValue(now + 120_000);
    for (const entity of backgroundEvents) {
      await backgroundEvent(client, entity);
      unchanged();
      expect(locate).toHaveBeenCalledExactlyOnceWith(SOURCE, 7);
      expect(list).toHaveBeenCalledExactlyOnceWith(DESTINATION, {
        numbers: [55],
        limit: 1,
      });
      expect(getComment).not.toHaveBeenCalled();
      expect(getIssue).not.toHaveBeenCalled();
      expect(client.getQueryData(locationKey)).toBe(locationData);
      expect(client.getQueryState(locationKey)?.dataUpdatedAt).toBe(now);
      expect(client.getQueryData(targetKey)).toEqual(staleTarget);
      expect(client.getQueryState(targetKey)?.dataUpdatedAt).toBe(
        staleUpdatedAt,
      );
    }
  });
});

describe("search permissions independent of static display references", () => {
  it.each([403, 404])(
    "discards an old pending issue search after membership refresh returns %i without changing display",
    async (status) => {
      const old = deferred<IssueListPage>();
      const refreshed = deferred<IssueListPage>();
      const list = vi
        .spyOn(api, "listIssues")
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(refreshed.promise);
      const getIssue = vi.spyOn(api, "getIssue").mockRejectedValue({ status });
      const client = seeded();
      mockDirectories(client);
      const displayKey = issueRefQuery(SOURCE, 12).queryKey;
      client.setQueryData(displayKey, issue(12));
      client.setQueryData<ResolvedCommentRef>(
        commentRefQuery(SOURCE, 12, 7).queryKey,
        { ...comment(), at: { slug: SOURCE, number: 12, commentId: 8 } },
      );
      const view = renderWithProviders(
        <MarkdownView slug={SOURCE}>
          {"[**original label**](/projects/historical/issues/12#comment-7)"}
        </MarkdownView>,
        client,
      );
      const anchor = await waitFor(() => {
        const link = view.container.querySelector("a[data-comment-link='8']");
        expect(link).not.toBeNull();
        return link as HTMLAnchorElement;
      });
      const card = await hover(anchor);
      expect(card.textContent).toContain("Old authorized body");
      const unchanged = unchangedReference(view.container, anchor, card);
      const displayData = client.getQueryData(displayKey);
      expect(list).not.toHaveBeenCalled();

      const options = searchIssueRefQuery(SOURCE, 12);
      const key = options.queryKey;
      const observer = new QueryObserver(client, options);
      unsubscribeSearch.push(observer.subscribe(() => {}));
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      expect(key).toEqual(["search-issue-ref", SOURCE, 12]);
      expect(client.getQueryState(key)?.status).toBe("pending");
      expect(client.getQueryData(key)).toBeUndefined();
      unchanged();

      await backgroundEvent(client, "member", SOURCE, 12);
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      // invalidateQueries alone would reuse the pending promise when no
      // search data has landed. A new generation must check current access.
      await act(async () =>
        refreshed.resolve({ items: [], next_cursor: null }),
      );
      await waitFor(() => expect(client.getQueryData(key)).toBeNull());
      expect(getIssue).toHaveBeenCalledExactlyOnceWith(SOURCE, 12);
      unchanged();
      await act(async () => {
        old.resolve({ items: [issue(12)], next_cursor: null });
        await old.promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
      expect(client.getQueryData(key)).toBeNull();
      expect(client.getQueryState(key)?.fetchStatus).toBe("idle");
      expect(list).toHaveBeenCalledTimes(2);
      expect(getIssue).toHaveBeenCalledTimes(1);
      expect(client.getQueryData(displayKey)).toBe(displayData);
      unchanged();
    },
  );

  it.each([
    { entity: "comment" as const, status: 403 },
    { entity: "timeline" as const, status: 404 },
  ])(
    "cancels pending comment and location searches on $entity events, confirms new permissions and preserves display",
    async ({ entity, status }) => {
      const oldComment = deferred<TimelineComment>();
      const freshComment = deferred<TimelineComment>();
      const oldLocation = deferred<LocatedComment>();
      const freshLocation = deferred<LocatedComment>();
      const getComment = vi
        .spyOn(api, "getComment")
        .mockReturnValueOnce(oldComment.promise)
        .mockReturnValueOnce(freshComment.promise);
      const locate = vi
        .spyOn(api, "locateComment")
        .mockReturnValueOnce(oldLocation.promise)
        .mockReturnValueOnce(freshLocation.promise);
      const list = vi.spyOn(api, "listIssues");
      const getIssue = vi.spyOn(api, "getIssue");
      const client = seeded();
      mockDirectories(client);
      const location: LocatedComment = {
        slug: DESTINATION,
        issue_number: 55,
        issue_ref: "destination#55",
        comment: comment(),
      };
      const displayLocationKey = commentLocationQuery(SOURCE, 7).queryKey;
      client.setQueryData(displayLocationKey, location);
      client.setQueryData(issueRefQuery(DESTINATION, 55).queryKey, issue(55));
      const view = renderWithProviders(
        <MarkdownView slug={SOURCE} preview>
          {"#comment-7"}
        </MarkdownView>,
        client,
      );
      const anchor = await waitFor(() => {
        const link = view.container.querySelector("a[data-comment-link='8']");
        expect(link).not.toBeNull();
        return link as HTMLAnchorElement;
      });
      expectCommentIdentity(anchor, "destination/T-55#comment-8", "Alice");
      const card = await hover(anchor);
      expect(card.textContent).toContain("Old authorized body");
      const unchanged = unchangedReference(view.container, anchor, card);
      const displayCommentKey = commentRefQuery(DESTINATION, 55, 8).queryKey;
      const displayComment = client.getQueryData(displayCommentKey);
      const displayLocation = client.getQueryData(displayLocationKey);
      expect(getComment).not.toHaveBeenCalled();
      expect(locate).not.toHaveBeenCalled();

      const commentOptions = searchCommentRefQuery(SOURCE, 12, 7);
      const locationOptions = searchCommentLocationQuery(SOURCE, 7);
      const commentObserver = new QueryObserver(client, commentOptions);
      const locationObserver = new QueryObserver(client, locationOptions);
      unsubscribeSearch.push(
        commentObserver.subscribe(() => {}),
        locationObserver.subscribe(() => {}),
      );
      await waitFor(() => {
        expect(getComment).toHaveBeenCalledExactlyOnceWith(SOURCE, 12, 7);
        expect(locate).toHaveBeenCalledExactlyOnceWith(SOURCE, 7);
      });
      const keys = [commentOptions.queryKey, locationOptions.queryKey];
      expect(keys).toEqual([
        ["search-comment-ref", SOURCE, 12, 7],
        ["search-comment-location", SOURCE, 7],
      ]);
      for (const key of keys) {
        expect(client.getQueryState(key)?.status).toBe("pending");
        expect(client.getQueryData(key)).toBeUndefined();
      }
      await backgroundEvent(client, entity);
      await waitFor(() => {
        expect(getComment).toHaveBeenCalledTimes(2);
        expect(locate).toHaveBeenCalledTimes(2);
      });
      await act(async () => {
        freshComment.reject({ status });
        freshLocation.reject({ status });
      });
      await waitFor(() => {
        for (const key of keys) expect(client.getQueryData(key)).toBeNull();
      });
      unchanged();
      await act(async () => {
        oldComment.resolve(comment());
        oldLocation.resolve(location);
        await Promise.all([oldComment.promise, oldLocation.promise]);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
      for (const key of keys) {
        expect(client.getQueryData(key)).toBeNull();
        expect(client.getQueryState(key)?.fetchStatus).toBe("idle");
      }
      expect(getComment).toHaveBeenCalledTimes(2);
      expect(locate).toHaveBeenCalledTimes(2);
      unchanged();

      // Access granted later is checked by search, while the existing page
      // retains its original author/body and the exact same hover subtree.
      getComment.mockResolvedValue(comment(bob));
      locate.mockResolvedValue({ ...location, comment: comment(bob) });
      await backgroundEvent(client, entity);
      await waitFor(() => {
        expect(client.getQueryData(commentOptions.queryKey)?.author).toEqual(
          bob,
        );
        expect(
          client.getQueryData(locationOptions.queryKey)?.comment.author,
        ).toEqual(bob);
      });
      expect(getComment).toHaveBeenCalledTimes(3);
      expect(locate).toHaveBeenCalledTimes(3);
      expect(list).not.toHaveBeenCalled();
      expect(getIssue).not.toHaveBeenCalled();
      expect(client.getQueryData(displayLocationKey)).toBe(displayLocation);
      expect(client.getQueryData(displayCommentKey)).toBe(displayComment);
      unchanged();
    },
  );
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
