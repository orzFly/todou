import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ActivityPage,
  ActivityQuery,
  CommentCreateInput,
  CommentUpdateInput,
  Issue,
  IssueCounts,
  IssueCountsQuery,
  IssueCreateInput,
  IssueListPage,
  IssueListQuery,
  IssueUpdateInput,
  ProjectSlug,
  RevisionPage,
  RevisionQuery,
  TimelineComment,
  TimelinePage,
  TimelineQuery,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createComment,
  deleteComment,
  updateComment,
} from "../services/comments.ts";
import {
  countIssuesByCategory,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
} from "../services/issues.ts";
import {
  listCommentRevisions,
  listIssueRevisions,
} from "../services/revisions.ts";
import { getProjectActivity, getTimeline } from "../services/timeline.ts";

const issueNumber = z.coerce.number().int().positive();
const slugParam = z.object({ slug: ProjectSlug });
const issueParams = z.object({ slug: ProjectSlug, number: issueNumber });
const commentParams = z.object({
  slug: ProjectSlug,
  number: issueNumber,
  commentId: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const listRoute = createRoute({
  method: "get",
  path: "/{slug}/issues",
  summary: "List issues with filters and cursor pagination",
  request: { params: slugParam, query: IssueListQuery },
  responses: { 200: { description: "Page", ...jsonBody(IssueListPage) } },
});

const countsRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/counts",
  summary: "Open/closed totals under the same (category-neutral) filters",
  request: { params: slugParam, query: IssueCountsQuery },
  responses: { 200: { description: "Counts", ...jsonBody(IssueCounts) } },
});

const createIssueRoute = createRoute({
  method: "post",
  path: "/{slug}/issues",
  summary: "Open an issue (writer)",
  request: { params: slugParam, body: jsonBody(IssueCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(Issue) } },
});

const getIssueRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}",
  summary: "Issue details",
  request: { params: issueParams },
  responses: { 200: { description: "Issue", ...jsonBody(Issue) } },
});

const patchIssueRoute = createRoute({
  method: "patch",
  path: "/{slug}/issues/{number}",
  summary:
    "Update title/body/status/assignees/labels (writer); every change is " +
    "recorded as a timeline event",
  request: { params: issueParams, body: jsonBody(IssueUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(Issue) } },
});

const timelineRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/timeline",
  summary: "Merged comments × events stream with bidirectional cursors",
  request: { params: issueParams, query: TimelineQuery },
  responses: { 200: { description: "Page", ...jsonBody(TimelinePage) } },
});

const activityRoute = createRoute({
  method: "get",
  path: "/{slug}/activity",
  summary:
    "Project-wide activity stream (forward cursor poll across all issues)",
  request: { params: slugParam, query: ActivityQuery },
  responses: { 200: { description: "Page", ...jsonBody(ActivityPage) } },
});

const createCommentRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/comments",
  summary: "Comment on an issue (writer)",
  request: { params: issueParams, body: jsonBody(CommentCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(TimelineComment) } },
});

const patchCommentRoute = createRoute({
  method: "patch",
  path: "/{slug}/issues/{number}/comments/{commentId}",
  summary: "Edit a comment (author or project admin)",
  request: { params: commentParams, body: jsonBody(CommentUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(TimelineComment) } },
});

const issueRevisionsRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/revisions",
  summary: "Issue body edit history, newest first, both sides paired",
  request: { params: issueParams, query: RevisionQuery },
  responses: { 200: { description: "Page", ...jsonBody(RevisionPage) } },
});

const commentRevisionsRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/comments/{commentId}/revisions",
  summary: "Comment edit history, newest first, both sides paired",
  request: { params: commentParams, query: RevisionQuery },
  responses: { 200: { description: "Page", ...jsonBody(RevisionPage) } },
});

const deleteCommentRoute = createRoute({
  method: "delete",
  path: "/{slug}/issues/{number}/comments/{commentId}",
  summary: "Delete a comment (author or project admin)",
  request: { params: commentParams },
  responses: { 204: { description: "Deleted" } },
});

export function issueRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(listRoute, async (c) => {
    const { slug } = c.req.valid("param");
    const page = await listIssues(
      c.get("appCtx"),
      c.get("user"),
      slug,
      c.req.valid("query"),
    );
    // The list schema omits body; strip it so large bodies never ship.
    return c.json(
      {
        items: page.items.map(({ body: _body, ...rest }) => rest),
        next_cursor: page.next_cursor,
      },
      200,
    );
  });

  app.openapi(countsRoute, async (c) => {
    const { slug } = c.req.valid("param");
    return c.json(
      await countIssuesByCategory(
        c.get("appCtx"),
        c.get("user"),
        slug,
        c.req.valid("query"),
      ),
      200,
    );
  });

  app.openapi(createIssueRoute, async (c) => {
    const { slug } = c.req.valid("param");
    return c.json(
      await createIssue(
        c.get("appCtx"),
        c.get("user"),
        slug,
        c.req.valid("json"),
        c.get("agentContext"),
      ),
      201,
    );
  });

  app.openapi(getIssueRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await getIssue(c.get("appCtx"), c.get("user"), slug, number),
      200,
    );
  });

  app.openapi(patchIssueRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await updateIssue(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("json"),
        c.get("agentContext"),
      ),
      200,
    );
  });

  app.openapi(timelineRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await getTimeline(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("query"),
      ),
      200,
    );
  });

  app.openapi(activityRoute, async (c) =>
    c.json(
      await getProjectActivity(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("query"),
      ),
      200,
    ),
  );

  app.openapi(createCommentRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await createComment(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("json"),
        c.get("agentContext"),
      ),
      201,
    );
  });

  app.openapi(patchCommentRoute, async (c) => {
    const { slug, number, commentId } = c.req.valid("param");
    return c.json(
      await updateComment(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        commentId,
        c.req.valid("json"),
        c.get("agentContext"),
      ),
      200,
    );
  });

  app.openapi(issueRevisionsRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await listIssueRevisions(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("query"),
      ),
      200,
    );
  });

  app.openapi(commentRevisionsRoute, async (c) => {
    const { slug, number, commentId } = c.req.valid("param");
    return c.json(
      await listCommentRevisions(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        commentId,
        c.req.valid("query"),
      ),
      200,
    );
  });

  app.openapi(deleteCommentRoute, async (c) => {
    const { slug, number, commentId } = c.req.valid("param");
    await deleteComment(
      c.get("appCtx"),
      c.get("user"),
      slug,
      number,
      commentId,
    );
    return c.body(null, 204);
  });

  return app;
}
