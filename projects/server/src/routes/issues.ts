import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ActivityPage,
  ActivityQuery,
  AnswersSubmitInput,
  CommentCreateInput,
  CommentLocation,
  CommentUpdateInput,
  Issue,
  IssueCounts,
  IssueCountsQuery,
  IssueCreateInput,
  IssueListPage,
  IssueListQuery,
  IssueQuestions,
  IssueUpdateInput,
  ProjectSlug,
  RevisionPage,
  RevisionQuery,
  TimelineComment,
  TimelineEvent,
  TimelinePage,
  TimelineQuery,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createComment,
  deleteComment,
  getComment,
  locateComment,
  updateComment,
} from "../services/comments.ts";
import {
  countIssuesByCategory,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
} from "../services/issues.ts";
import { listIssueQuestions, submitAnswers } from "../services/questions.ts";
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
  summary:
    "Open/closed totals plus per-status detail under the same (category-neutral) filters",
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

const getCommentRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/comments/{commentId}",
  summary: "Fetch one comment (permalink resolution)",
  request: { params: commentParams },
  responses: { 200: { description: "Comment", ...jsonBody(TimelineComment) } },
});

const locateCommentRoute = createRoute({
  method: "get",
  path: "/{slug}/comments/{commentId}",
  summary:
    "Resolve a comment id to the issue carrying it (bare #comment-M refs)",
  request: {
    params: z.object({
      slug: ProjectSlug,
      commentId: z.coerce.number().int().positive(),
    }),
  },
  responses: { 200: { description: "Comment", ...jsonBody(CommentLocation) } },
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

const issueQuestionsRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/questions",
  summary:
    "Question comments of an issue with their answer status (T-19); powers " +
    "`todou question list/wait` and the web answer cards",
  request: { params: issueParams },
  responses: { 200: { description: "Status", ...jsonBody(IssueQuestions) } },
});

const submitAnswersRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/comments/{commentId}/answers",
  summary:
    "Answer every question of a comment atomically (writer); one answer " +
    "per comment, ever — answers cannot be edited",
  request: { params: commentParams, body: jsonBody(AnswersSubmitInput) },
  responses: {
    201: { description: "Answered", ...jsonBody(TimelineEvent) },
  },
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

  app.openapi(getCommentRoute, async (c) => {
    const { slug, number, commentId } = c.req.valid("param");
    return c.json(
      await getComment(c.get("appCtx"), c.get("user"), slug, number, commentId),
      200,
    );
  });

  app.openapi(locateCommentRoute, async (c) => {
    const { slug, commentId } = c.req.valid("param");
    return c.json(
      await locateComment(c.get("appCtx"), c.get("user"), slug, commentId),
      200,
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

  app.openapi(issueQuestionsRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await listIssueQuestions(c.get("appCtx"), c.get("user"), slug, number),
      200,
    );
  });

  app.openapi(submitAnswersRoute, async (c) => {
    const { slug, number, commentId } = c.req.valid("param");
    return c.json(
      await submitAnswers(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        commentId,
        c.req.valid("json"),
        c.get("agentContext"),
      ),
      201,
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
