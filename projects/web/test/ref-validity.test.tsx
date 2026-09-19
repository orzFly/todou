import { waitFor } from "@testing-library/react";
import type { IssueListItem, TimelineComment } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commentRefQuery,
  issueRefQuery,
  type ResolvedCommentRef,
} from "../src/api/issue-refs.ts";
import { IssueLink } from "../src/components/shared/issue-link.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const issue = (number: number, title = "Confirmed parent"): IssueListItem => ({
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
  author,
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

const comment = (hiddenAt: string | null = null): TimelineComment => ({
  type: "comment",
  id: 7,
  author,
  body: "comment body",
  created_at: "2026-09-01T00:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: hiddenAt,
  component: null,
  agent_context: null,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const source = "/projects/a/issues/12#comment-7";
const link = (slug = "a") => (
  <IssueLink
    slug={slug}
    number={12}
    commentId={7}
    pageSlug="a"
    fallbackHref={
      slug === "a" ? source : `/projects/${slug}/issues/12#comment-7`
    }
    fallbackChildren={<strong>original label</strong>}
    inBody
  />
);

const expectOrdinary = (root: ParentNode, href: string) => {
  const anchor = root.querySelector("a") as HTMLAnchorElement;
  expect(anchor.getAttribute("href")).toBe(href);
  expect(anchor.querySelector("strong")?.textContent).toBe("original label");
  expect(anchor.getAttribute("data-issue-link")).toBeNull();
  expect(anchor.getAttribute("data-comment-link")).toBeNull();
  expect(
    anchor.querySelector("[data-comment-ref], [data-comment-author]"),
  ).toBeNull();
  expect(anchor.getAttribute("title")).toBeNull();
  expect(anchor.querySelector("svg")).toBeNull();
  expect(anchor.textContent).not.toContain("Confirmed parent");
};

const expectCommentRef = (anchor: HTMLAnchorElement, spelled: string) => {
  const tokens = anchor.querySelectorAll("[data-comment-ref]");
  expect(tokens).toHaveLength(1);
  const token = tokens[0] as HTMLElement;
  expect(token.textContent).toBe(spelled);
  expect(token.childNodes).toHaveLength(1);
  expect(token.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  expect(token.closest("[hidden], [aria-hidden='true'], .sr-only")).toBeNull();
  expect(getComputedStyle(token).display).not.toBe("none");
  expect(getComputedStyle(token).visibility).not.toBe("hidden");
  expect(getComputedStyle(token).visibility).not.toBe("collapse");
  expect(anchor.textContent?.split(spelled)).toHaveLength(2);
  const authors = anchor.querySelectorAll("[data-comment-author]");
  expect(authors).toHaveLength(1);
  expect(authors[0]?.textContent).toBe(" · by Alice");
  expect(token.contains(authors[0] ?? null)).toBe(false);
};

afterEach(() => vi.unstubAllGlobals());

describe("one full-target confirmation gate", () => {
  it.each([null, { ...issue(12), deleted_at: "2026-09-02T00:00:00Z" }])(
    "cannot enrich a missing or trash-readable deleted issue",
    async (target) => {
      const queries = testQueryClient();
      queries.setQueryData(issueRefQuery("a", 12).queryKey, target);
      queries.setQueryData<ResolvedCommentRef | null>(
        commentRefQuery("a", 12, 7).queryKey,
        () => ({
          ...comment(),
          at: { slug: "a", number: 12, commentId: 7 },
        }),
      );
      const view = renderWithProviders(link(), queries);
      await waitFor(() =>
        expect(view.container.querySelector("a")).not.toBeNull(),
      );
      expectOrdinary(view.container, source);
    },
  );

  it("cannot enrich a missing comment or a comment that moved to another parent", async () => {
    for (const target of [
      null,
      {
        ...comment(),
        at: { slug: "b", number: 55, commentId: 7 },
      },
    ]) {
      const queries = testQueryClient();
      queries.setQueryData(issueRefQuery("a", 12).queryKey, issue(12));
      queries.setQueryData<ResolvedCommentRef | null>(
        commentRefQuery("a", 12, 7).queryKey,
        target,
      );
      const view = renderWithProviders(link(), queries);
      await waitFor(() =>
        expect(view.container.querySelector("a")).not.toBeNull(),
      );
      expectOrdinary(view.container, source);
      view.unmount();
    }
  });

  it("accepts a matching hidden comment without exposing its body in the link", async () => {
    const queries = testQueryClient();
    queries.setQueryData(issueRefQuery("a", 12).queryKey, issue(12));
    queries.setQueryData<ResolvedCommentRef | null>(
      commentRefQuery("a", 12, 7).queryKey,
      () => ({
        ...comment("2026-09-02T00:00:00Z"),
        at: { slug: "a", number: 12, commentId: 7 },
      }),
    );
    const view = renderWithProviders(link(), queries);
    const rich = await waitFor(() => {
      const anchor = view.container.querySelector("a[data-comment-link='7']");
      expect(anchor).not.toBeNull();
      return anchor as HTMLAnchorElement;
    });
    expect(rich.getAttribute("href")).toBe(source);
    expect(rich.textContent).toContain("Confirmed parent");
    expectCommentRef(rich, "#12#comment-7");
    expect(rich.getAttribute("data-comment-link")).toBe("7");
    expect(rich.hash).toBe(`#comment-${rich.dataset.commentLink}`);
    expect(rich.textContent).not.toContain("comment body");
  });

  it.each(["old-slug", "9"])(
    "uses the authorized destination for a %s unreadable-source address",
    async (slug) => {
      const urls: string[] = [];
      vi.stubGlobal("fetch", (async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("numbers="))
          return json({ error: { code: "forbidden" } }, 403);
        if (url.includes(`/projects/${slug}/issues/12/comments/7`)) {
          return json(
            { moved_to: { slug: "b", number: 55, comment_id: 8 } },
            301,
          );
        }
        if (url.includes(`/projects/${slug}/issues/12`)) {
          return json({ moved_to: { slug: "b", number: 55 } }, 301);
        }
        if (url.includes("/projects/b/issues/55/comments/8")) {
          return json({ ...comment(), id: 8 });
        }
        if (url.includes("/projects/b/issues/55")) {
          return json({ ...issue(55, "Destination"), body: "" });
        }
        return json({ error: { code: "not_found" } }, 404);
      }) as typeof fetch);
      const queries = testQueryClient();
      const view = renderWithProviders(link(slug), queries);
      const rich = await waitFor(() => {
        const anchor = view.container.querySelector("a[data-comment-link='8']");
        expect(anchor).not.toBeNull();
        return anchor as HTMLAnchorElement;
      });
      expect(rich.getAttribute("href")).toBe("/projects/b/issues/55#comment-8");
      expect(rich.getAttribute("data-comment-link")).toBe("8");
      // The author and final parent alone cannot identify the moved comment.
      expectCommentRef(rich, "b#55#comment-8");
      expect(rich.textContent?.match(/#comment-\d+/g)).toEqual(["#comment-8"]);
      expect(rich.hash).toBe(`#comment-${rich.dataset.commentLink}`);
      expect(
        view.container.querySelector("a[data-comment-link='7']"),
      ).toBeNull();
      expect(rich.getAttribute("data-issue-link")).toBe("55");
      expect(rich.getAttribute("data-issue-project")).toBe("b");
      expect(rich.textContent).toContain("Destination");
      expect(urls).toEqual(
        expect.arrayContaining([
          `/api/projects/${slug}/issues/12`,
          `/api/projects/${slug}/issues/12/comments/7`,
          "/api/projects/b/issues/55",
          "/api/projects/b/issues/55/comments/8",
        ]),
      );
      expect(
        queries.getQueryData(issueRefQuery(slug, 12).queryKey)?.at,
      ).toEqual({ slug: "b", number: 55 });
      expect(
        queries.getQueryData(commentRefQuery(slug, 12, 7).queryKey),
      ).toMatchObject({
        id: 8,
        at: { slug: "b", number: 55, commentId: 8 },
      });
      for (const key of [
        issueRefQuery(slug, 12).queryKey,
        commentRefQuery(slug, 12, 7).queryKey,
      ]) {
        expect(queries.getQueryState(key)).toMatchObject({
          status: "success",
          fetchStatus: "idle",
          isInvalidated: false,
        });
      }
    },
  );

  it("keeps a source-only address ordinary when the final issue is unreadable", async () => {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("numbers="))
        return json({ error: { code: "forbidden" } }, 403);
      if (url.includes("/projects/a/issues/12/comments/7")) {
        return json(
          { moved_to: { slug: "b", number: 55, comment_id: 8 } },
          301,
        );
      }
      if (url.includes("/projects/a/issues/12")) {
        return json({ moved_to: { slug: "b", number: 55 } }, 301);
      }
      return json({ error: { code: "forbidden" } }, 403);
    }) as typeof fetch);
    const queries = testQueryClient();
    const view = renderWithProviders(link(), queries);
    await waitFor(() => {
      expect(
        queries.getQueryState(issueRefQuery("a", 12).queryKey)?.status,
      ).toBe("success");
      expect(
        view.container.querySelector(
          "a[href='/projects/a/issues/12#comment-7']",
        ),
      ).not.toBeNull();
    });
    expectOrdinary(view.container, source);
  });
});
