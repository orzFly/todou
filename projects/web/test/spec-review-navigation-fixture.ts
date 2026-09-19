import {
  type IssueListItem,
  type Me,
  type SpecInfo,
  SpecReviewResult,
  SpecReviewSubmitInput,
  type SpecReviewVerdict,
  TimelinePage,
} from "@todou/shared";
import { type Mock, vi } from "vitest";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";

export const ISSUE_TITLE = "Review navigation proposal";
export const ISSUE_URL = "/projects/demo/issues/7";
export const SPEC_URL =
  "/projects/demo/issues/7/spec?v=1&file=proposal.md#spec-top";
export const TAIL_KEY = ["timeline", "demo", 7, "tail"] as const;
export const SUMMARY =
  "review summary\n\n[review event](/projects/demo/issues/7#event-901)";

const CREATED_AT = "2026-01-01T00:00:00Z";
const REVIEW_AT = "2026-02-02T00:00:00Z";
const FILE_BODY = "# Proposal\n\nA proposal for review navigation.\n";

export const ME: Me = {
  id: 9,
  login: "reviewer",
  display_name: "Reviewer",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: CREATED_AT,
};

const ALICE = {
  id: 3,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
  created_at: CREATED_AT,
};

const PROJECT = {
  id: 1,
  slug: "demo",
  name: "Demo",
  description: "",
  created_at: CREATED_AT,
  viewer_role: "writer" as const,
  former_slugs: [],
  icon_url: null,
};

const TODO = {
  id: 1,
  name: "Todo",
  category: "open" as const,
  color: "#6b7280",
  position: 0,
  is_default: true,
};
const DOING = { ...TODO, id: 2, name: "Doing", position: 1, is_default: false };

export const SPEC: SpecInfo = {
  current_version: 1,
  current_version_cursor: "spec-v1",
  review_status: "unreviewed",
  viewer_review: { user_id: ME.id, approved_in_current_round: false },
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [{ path: "proposal.md", size: FILE_BODY.length }],
  versions: [
    {
      number: 1,
      author: ALICE,
      message: "Initial proposal",
      created_at: CREATED_AT,
    },
  ],
};

export const DRAFT: SpecReviewDraft = {
  id: "navigation-draft",
  anchor: {
    path: "proposal.md",
    version: 1,
    line_start: 1,
    line_end: 1,
    col_start: null,
    col_end: null,
  },
  quote: "# Proposal",
  body: "annotation body",
};

const ANCHOR = { ...DRAFT.anchor, quote: DRAFT.quote };
const ISSUE: IssueListItem = {
  id: 107,
  number: 7,
  title: ISSUE_TITLE,
  status: TODO,
  author: ALICE,
  assignees: [ALICE],
  labels: [],
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  body_edited_at: null,
  open_questions: 0,
  spec_version: 1,
  spec_review_status: "unreviewed",
  spec_unresolved_comments: 0,
  unread: true,
  unread_comments: 1,
  muted: null,
  deleted_at: null,
  deleted_by: null,
  blocked_by: [],
  blocks: [],
  moves: [],
};
const PROJECT_REF = { slug: PROJECT.slug, name: PROJECT.name, icon_url: null };

export function reviewResult(verdict: SpecReviewVerdict): SpecReviewResult {
  return SpecReviewResult.parse({
    event_id: 901,
    version: 1,
    verdict,
    summary_comment_id: 902,
    comment_ids: [903],
  });
}

/** The returned event lies on the older page; a concurrent review is newer. */
export function reviewPages(verdict: SpecReviewVerdict): {
  older: TimelinePage;
  newer: TimelinePage;
  empty: TimelinePage;
} {
  const comment = {
    type: "comment" as const,
    author: ME,
    component: null,
    created_at: REVIEW_AT,
    edited_at: null,
    resolved_at: null,
    hidden_at: null,
    agent_context: null,
  };
  const event = {
    type: "event" as const,
    event_type: "spec_review" as const,
    actor: ME,
    created_at: REVIEW_AT,
    agent_context: null,
  };
  return {
    older: TimelinePage.parse({
      items: [
        {
          ...comment,
          id: 900,
          author: ALICE,
          body: "ordinary discussion",
          created_at: CREATED_AT,
        },
        {
          ...event,
          id: 901,
          payload: {
            version: 1,
            verdict,
            comment_id: 902,
            annotation_count: 1,
          },
        },
      ],
      prev_cursor: null,
      next_cursor: "after-901",
      has_more: false,
      total_count: 5,
    }),
    newer: TimelinePage.parse({
      items: [
        { ...comment, id: 902, body: SUMMARY },
        {
          ...comment,
          id: 903,
          body: DRAFT.body,
          component: { type: "spec_comment", anchor: ANCHOR },
        },
        {
          ...event,
          id: 904,
          payload: {
            version: 1,
            verdict,
            comment_id: null,
            annotation_count: 0,
          },
        },
      ],
      prev_cursor: "before-newer",
      next_cursor: "after-904",
      has_more: true,
      total_count: 5,
    }),
    empty: TimelinePage.parse({
      items: [],
      prev_cursor: null,
      next_cursor: null,
      has_more: false,
      total_count: 0,
    }),
  };
}

export type Deferred<T> = {
  promise: Promise<T>;
  release: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export type ReviewApiFixture = {
  fetch: Mock<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >;
  posts: { body: SpecReviewSubmitInput; url: URL; time: number }[];
  timelineReads: { url: URL; time: number }[];
  unmatchedRequests: { method: string; url: URL; time: number }[];
  postReply: (body: SpecReviewSubmitInput) => Promise<Response>;
  timelineReply: (url: URL) => Promise<Response>;
  specReply: () => Promise<Response>;
};

const outstanding = new Set<(reason?: unknown) => void>();

/** Retire requests even when an assertion failed before its scripted reply. */
export function rejectHeldRequests() {
  for (const reject of outstanding) reject(new Error("test request disposed"));
  outstanding.clear();
}

export function held<T>(): Deferred<T> {
  let release!: Deferred<T>["release"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });
  outstanding.add(reject);
  void promise.then(
    () => outstanding.delete(reject),
    () => outstanding.delete(reject),
  );
  return { promise, release, reject };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch fixture for the real app router, following return-navigation's API
 * data shapes. Handlers are mutable so a test can hold a POST or a timeline
 * page while the real navigation, cache and completion code keep running.
 */
export function reviewApiFixture(): ReviewApiFixture {
  let committedVerdict: SpecReviewVerdict | null = null;
  let read = false;
  const posts: ReviewApiFixture["posts"] = [];
  const timelineReads: ReviewApiFixture["timelineReads"] = [];
  const unmatchedRequests: ReviewApiFixture["unmatchedRequests"] = [];
  const empty = reviewPages("comment").empty;

  const server: Omit<ReviewApiFixture, "fetch"> = {
    posts,
    timelineReads,
    unmatchedRequests,
    specReply: async () => json(currentSpec()),
    postReply: async (body: SpecReviewSubmitInput): Promise<Response> =>
      json(reviewResult(body.verdict), 201),
    timelineReply: async (url: URL): Promise<Response> => {
      if (committedVerdict === null) return json(empty);
      const pages = reviewPages(committedVerdict);
      // InfiniteQuery refetches a loaded pair forward from its oldest page.
      if (url.searchParams.get("after") === "after-901") {
        return json(pages.newer);
      }
      if (url.searchParams.has("after")) return json(pages.empty);
      if (url.searchParams.has("before")) return json(pages.older);
      return json(url.searchParams.has("last") ? pages.newer : pages.older);
    },
  };

  const currentSpec = (): SpecInfo => ({
    ...SPEC,
    review_status:
      committedVerdict === "approve"
        ? "approved"
        : committedVerdict === "request_changes"
          ? "changes_requested"
          : "unreviewed",
    viewer_review: {
      user_id: ME.id,
      approved_in_current_round: committedVerdict === "approve",
    },
    unresolved_comments: committedVerdict === null ? 0 : 1,
  });
  const listItem = () => ({
    ...ISSUE,
    spec_review_status: currentSpec().review_status,
    spec_unresolved_comments: currentSpec().unresolved_comments,
    unread: !read,
    unread_comments: read ? 0 : 1,
    project: PROJECT_REF,
  });
  const listItems = (url: URL) => {
    const query = url.searchParams;
    const status = query.get("status");
    const numbers = query.get("numbers");
    const category = query.get("category");
    const deleted = query.get("deleted");
    if (
      deleted === "1" ||
      deleted === "true" ||
      query.has("cursor") ||
      (category !== null && category !== TODO.category) ||
      (status !== null && !status.split(",").includes(String(TODO.id))) ||
      (numbers !== null && !numbers.split(",").includes(String(ISSUE.number)))
    ) {
      return [];
    }
    return [listItem()];
  };

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;
    const url = new URL(raw, "http://localhost");
    const path = url.pathname.replace(/^\/api(?=\/)/, "");
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const time = Date.now();

    if (method === "POST" && path === `${ISSUE_URL}/spec/reviews`) {
      // The normal client passes a JSON string: record it before yielding to
      // the configurable handler, including when that handler never settles.
      const body = SpecReviewSubmitInput.parse(
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : input instanceof Request
            ? await input.clone().json()
            : undefined,
      );
      posts.push({ body, url, time });
      const response = await server.postReply(body);
      if (response.ok) committedVerdict = body.verdict;
      return response;
    }
    if (method === "GET" && path === `${ISSUE_URL}/timeline`) {
      timelineReads.push({ url, time });
      return committedVerdict === null
        ? json(empty)
        : server.timelineReply(url);
    }
    if (
      method === "PUT" &&
      (path === `${ISSUE_URL}/read` || path === "/me/read")
    ) {
      read = true;
      return json({});
    }

    if (method === "GET") {
      switch (path) {
        case "/me":
          return json(ME);
        case "/version":
          return json({ version: "test" });
        case "/auth/mode":
          return json({ mode: "local" });
        case "/projects":
          return json([PROJECT]);
        case "/projects/demo":
          return json(PROJECT);
        case "/projects/demo/statuses":
          return json([TODO, DOING]);
        case "/projects/demo/labels":
          return json([]);
        case "/projects/demo/members":
          return json([
            { user: ME, role: "writer", created_at: CREATED_AT },
            { user: ALICE, role: "writer", created_at: CREATED_AT },
          ]);
        case "/me/prefs":
          return json({
            show_weak_unread: true,
            ref_placement_list: "before",
            ref_placement_board: "own_line",
            ref_placement_detail: "before",
            ref_placement_reference: "before",
            boxed_ref_links: true,
            truncate_ref_title: true,
            show_repeated_ref_title: false,
          });
        case "/me/mutes":
          return json({ issues: [], projects: [] });
        case "/me/reference-directory":
          return json({
            entries: [
              { prefix: "T", slug: "demo", from: CREATED_AT, to: null },
            ],
            contested: [],
            slug_entries: [
              { slug: "demo", canonical: "demo", from: CREATED_AT, to: null },
            ],
          });
        case "/projects/demo/references/config":
          return json({ format: { prefix: "T", history: [] }, autolinks: [] });
        case "/projects/demo/issues":
          return json({ items: listItems(url), next_cursor: null });
        case "/projects/demo/issues/counts":
          return json({ open: 1, closed: 0, by_status: { "1": 1, "2": 0 } });
        case ISSUE_URL:
          return json({ ...listItem(), body: "A proposal to review." });
        case "/projects/demo/attachments":
          return json([]);
        case `${ISSUE_URL}/metadata`:
          return json({ entries: [] });
        case `${ISSUE_URL}/metadata/namespaces`:
          return json({ namespaces: [] });
        case `${ISSUE_URL}/spec`:
          return server.specReply();
        case `${ISSUE_URL}/spec/files`:
          if (
            url.searchParams.has("version") &&
            url.searchParams.get("version") !== "1"
          ) {
            break;
          }
          return json({
            version: 1,
            files: [
              { path: "proposal.md", body: FILE_BODY, size: FILE_BODY.length },
            ],
          });
        case `${ISSUE_URL}/spec/comments`:
          return json({
            current_version: 1,
            items:
              committedVerdict === null
                ? []
                : [
                    {
                      comment_id: 903,
                      author: ME,
                      created_at: REVIEW_AT,
                      body: DRAFT.body,
                      hidden_at: null,
                      anchor: ANCHOR,
                      resolved: null,
                      outdated: false,
                      current_line_start: 1,
                      current_line_end: 1,
                    },
                  ],
          });
        case "/projects/demo/search/facets":
          return json({ harnesses: [], sessions: [] });
        case "/projects/demo/search":
          return json({
            items: [
              {
                kind: "spec",
                issue: { number: 7, title: ISSUE_TITLE, status: TODO },
                comment_id: null,
                spec_path: "proposal.md",
                field: "body",
                snippet: {
                  text: "A proposal for review navigation.",
                  ranges: [],
                },
                hidden: false,
                updated_at: CREATED_AT,
              },
            ],
            has_more: false,
            diagnostics: [],
          });
        case "/me/inbox":
          return json({
            items: [
              {
                ...listItem(),
                last_activity_at: CREATED_AT,
                pending_spec_review:
                  committedVerdict === null || committedVerdict === "comment",
                mentions_you: false,
              },
            ],
            truncated: false,
            unread_counts: { demo: read ? 0 : 1 },
          });
        case "/users/alice":
        case "/users/3":
          return json(ALICE);
        case "/users/alice/issues":
        case "/users/3/issues":
          return json({
            items:
              url.searchParams.get("state") === "closed" ||
              url.searchParams.has("after")
                ? []
                : [listItem()],
            next_cursor: null,
            has_more: false,
          });
        case "/users/alice/projects":
        case "/users/3/projects":
          return json({ items: [] });
      }
    }

    unmatchedRequests.push({ method, url, time });
    return json(
      {
        error: {
          code: "not_found",
          message: `fixture missing ${method} ${url.pathname}${url.search}`,
        },
      },
      404,
    );
  });

  return Object.assign(server, { fetch });
}
