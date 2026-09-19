import type { QueryClient } from "@tanstack/react-query";
import type { IssueListItem, ReferenceDirectory } from "@todou/shared";
import { vi } from "vitest";
import {
  commentRefQuery,
  issueRefQuery,
  type ResolvedCommentRef,
  type ResolvedIssueRef,
} from "../src/api/issue-refs.ts";
import {
  labelsQuery,
  membersQuery,
  projectQuery,
  projectsQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { searchFacetsQuery } from "../src/api/search.ts";

export const COMMENT_INPUTS = ["T-141#comment-1837", "#comment-1837"];
export const COMMENT_TARGET = "/projects/mirror/issues/30#comment-900";
export const COMMENT_SPELLED = "mirror/M-30#comment-900";
export const COMMENT_TITLE = "Moved discussion";

export const movedComment = (): ResolvedCommentRef => ({
  type: "comment",
  id: 900,
  author: {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  body: "The migrated comment body",
  created_at: "2026-08-30T08:00:00Z",
  component: null,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
  at: { slug: "mirror", number: 30, commentId: 900 },
});

/** Context only: successful targets still come through the real query functions. */
export function seedSearchCommentContext(client: QueryClient) {
  const projects = ["todou", "mirror"].map((slug, index) => ({
    id: index + 1,
    slug,
    name: slug === "todou" ? "Todou" : "Mirror",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
  }));
  client.setQueryData(projectsQuery.queryKey, projects);
  for (const project of projects) {
    client.setQueryData(projectQuery(project.slug).queryKey, project);
    client.setQueryData(referenceConfigQuery(project.slug).queryKey, {
      format: { prefix: project.slug === "todou" ? "T" : "M", history: [] },
      autolinks: [],
    });
  }
  client.setQueryData<ReferenceDirectory | null>(
    referenceDirectoryQuery.queryKey,
    () => ({
      entries: [
        { prefix: "T", slug: "todou", from: "2020-01-01T00:00:00Z", to: null },
        { prefix: "M", slug: "mirror", from: "2020-01-01T00:00:00Z", to: null },
      ],
      contested: [],
    }),
  );
  client.setQueryData(labelsQuery("todou").queryKey, []);
  client.setQueryData(membersQuery("todou").queryKey, []);
  client.setQueryData(statusesQuery("todou").queryKey, []);
  client.setQueryData(searchFacetsQuery("todou", true).queryKey, {
    harnesses: [],
    sessions: [],
  });
  client.removeQueries({ queryKey: issueRefQuery("todou", 141).queryKey });
  return client;
}

export function seedMovedComment(client: QueryClient, item: IssueListItem) {
  seedSearchCommentContext(client);
  client.setQueryData<ResolvedIssueRef | null>(
    issueRefQuery("todou", 141).queryKey,
    () => ({
      ...item,
      at: { slug: "mirror", number: 30 },
    }),
  );
  client.setQueryData(issueRefQuery("mirror", 30).queryKey, item);
  client.setQueryData(
    commentRefQuery("todou", 141, 1837).queryKey,
    movedComment(),
  );
  return client;
}

export const searchJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** HTTP aliases, not mocked hooks/API methods or pre-resolved query data. */
export function installSearchCommentHTTP(
  item: IssueListItem,
  commentResponse: () => Response | Promise<Response> = () => {
    const { at: _at, ...comment } = movedComment();
    return searchJson(comment);
  },
  commentId = 900,
) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.origin,
    );
    const path = url.pathname.replace(/^\/api/, "");
    requested.push(path);
    if (path === "/projects/todou/issues" && url.searchParams.has("numbers")) {
      return searchJson({ items: [], next_cursor: null });
    }
    if (path === "/projects/mirror/issues" && url.searchParams.has("numbers")) {
      return searchJson({ items: [item], next_cursor: null });
    }
    if (path === "/projects/todou/issues/141") {
      return searchJson(
        { moved_to: { slug: "mirror", number: item.number } },
        301,
      );
    }
    if (
      path === "/projects/todou/issues/141/comments/1837" ||
      path === "/projects/todou/comments/1837"
    ) {
      return searchJson(
        {
          moved_to: {
            slug: "mirror",
            number: item.number,
            comment_id: commentId,
          },
        },
        301,
      );
    }
    if (path === `/projects/mirror/issues/${item.number}`) {
      return searchJson({ ...item, body: "" });
    }
    if (
      path === `/projects/mirror/issues/${item.number}/comments/${commentId}`
    ) {
      return commentResponse();
    }
    return searchJson({ error: { code: "not_found", message: "no" } }, 404);
  }) as typeof fetch);
  return requested;
}
