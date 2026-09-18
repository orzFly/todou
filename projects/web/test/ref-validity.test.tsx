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
  expect(anchor.getAttribute("title")).toBeNull();
  expect(anchor.querySelector("svg")).toBeNull();
  expect(anchor.textContent).not.toContain("Confirmed parent");
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
    expect(rich.textContent).toContain("comment by Alice");
    expect(rich.textContent).not.toContain("comment body");
  });

  it.each(["old-slug", "9"])(
    "uses the authorized destination for a %s unreadable-source address",
    async (slug) => {
      vi.stubGlobal("fetch", (async (input: unknown) => {
        const url = String(input);
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
      const view = renderWithProviders(link(slug));
      const rich = await waitFor(() => {
        const anchor = view.container.querySelector("a[data-comment-link='8']");
        expect(anchor).not.toBeNull();
        return anchor as HTMLAnchorElement;
      });
      expect(rich.getAttribute("href")).toBe("/projects/b/issues/55#comment-8");
      expect(rich.getAttribute("data-comment-link")).toBe("8");
      expect(
        view.container.querySelector("a[data-comment-link='7']"),
      ).toBeNull();
      expect(rich.getAttribute("data-issue-link")).toBe("55");
      expect(rich.textContent).toContain("Destination");
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
