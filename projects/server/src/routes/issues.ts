import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ActivityPage,
  ActivityQuery,
  AnswersSubmitInput,
  CommandSubmitInput,
  CommandSubmitResult,
  CommentCreateInput,
  CommentCreateResult,
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
  MoveIssueInput,
  MoveIssueResult,
  minRoleOf,
  ProjectRef,
  RevisionPage,
  RevisionQuery,
  TimelineComment,
  TimelineEvent,
  TimelinePage,
  TimelineQuery,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { executeCommands } from "../services/commands.ts";
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
  deleteIssue,
  getIssue,
  listIssues,
  restoreIssue,
  updateIssue,
} from "../services/issues.ts";
import { moveIssue } from "../services/move/execute.ts";
import { listIssueQuestions, submitAnswers } from "../services/questions.ts";
import {
  listCommentRevisions,
  listIssueRevisions,
} from "../services/revisions.ts";
import { getProjectActivity, getTimeline } from "../services/timeline.ts";
import { movedResponses } from "./moved-responses.ts";
import { roleTag } from "./role-tag.ts";

const issueNumber = z.coerce.number().int().positive();
const slugParam = z.object({ slug: ProjectRef });
const issueParams = z.object({ slug: ProjectRef, number: issueNumber });
const commentParams = z.object({
  slug: ProjectRef,
  number: issueNumber,
  commentId: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

/**
 * Declared where it is a deliberate answer rather than the ambient one: on
 * an address whose card has moved, a reader who can read neither end gets
 * 404 and not the 410 above, which would confirm the address existed.
 */
const strangerResponse = {
  404: { description: "No such address, or neither project is readable" },
};

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
  summary:
    `Open an issue (${minRoleOf("issue.create")}); sending a status, ` +
    `labels or assignees with it needs ${minRoleOf("issue.triage")}`,
  request: { params: slugParam, body: jsonBody(IssueCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(Issue) } },
});

const getIssueRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}",
  summary: "Issue details",
  request: { params: issueParams },
  responses: {
    200: { description: "Issue", ...jsonBody(Issue) },
    ...movedResponses,
    ...strangerResponse,
  },
});

const patchIssueRoute = createRoute({
  method: "patch",
  path: "/{slug}/issues/{number}",
  summary:
    `Update title/body (${minRoleOf("issue.update")}, own issue only) or ` +
    `status/assignees/labels (${minRoleOf("issue.triage")}); every change ` +
    "is recorded as a timeline event",
  request: { params: issueParams, body: jsonBody(IssueUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(Issue) } },
});

const deleteIssueRoute = createRoute({
  method: "delete",
  path: "/{slug}/issues/{number}",
  summary: "Move an issue to the trash (author or project admin)",
  description:
    "Reversible: the row and everything hanging off it (comments, events, " +
    "attachments, spec, revisions, read state) stay put, and POST " +
    "`…/restore` brings all of it back. While it is in the trash the issue " +
    "is invisible to everyone but project admins and its author — inbound " +
    "references to it degrade to plain text, exactly like a number nobody " +
    "ever used — and every write to it answers 409. The number is never " +
    "recycled, deleted or not.",
  request: { params: issueParams },
  responses: { 204: { description: "Moved to the trash" } },
});

const restoreIssueRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/restore",
  summary: "Take an issue back out of the trash (author or project admin)",
  request: { params: issueParams },
  responses: { 200: { description: "Restored", ...jsonBody(Issue) } },
});

const moveIssueRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/move",
  summary: "Move an issue to another project (author or project admin)",
  description:
    "The card takes a new number in the destination and the old address " +
    "becomes a permanent tombstone that redirects: every link to it — " +
    "`#comment-N`, attachment URLs, other projects' timeline entries — " +
    "keeps working. Statuses, labels and assignees the destination has no " +
    "match for are mapped or dropped, never silently: `dry_run` returns the " +
    "same mapping without writing anything. Moving back into a project the " +
    "card has lived in before reclaims its original number.",
  request: { params: issueParams, body: jsonBody(MoveIssueInput) },
  responses: { 200: { description: "Moved", ...jsonBody(MoveIssueResult) } },
});

const timelineRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/timeline",
  summary: "Merged comments × events stream with bidirectional cursors",
  request: { params: issueParams, query: TimelineQuery },
  responses: {
    200: { description: "Page", ...jsonBody(TimelinePage) },
    ...movedResponses,
  },
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
  summary: `Comment on an issue ${roleTag("comment.create")}`,
  description:
    "The response carries the comment plus a `cursor` (T-182): resume a " +
    "timeline read or a watch from it — `--since <cursor>` — and every " +
    "entry created after this comment is delivered, this comment itself " +
    "excluded. Taking a cursor after the write instead leaves a window in " +
    "which the very answer being waited for can land unseen.",
  request: { params: issueParams, body: jsonBody(CommentCreateInput) },
  responses: {
    201: { description: "Created", ...jsonBody(CommentCreateResult) },
  },
});

const createCommandsRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/commands",
  summary:
    "Comment and apply incremental field commands in one transaction " +
    roleTag("comment.commands"),
  description:
    "What the web composer submits when the draft carried `/close`-style " +
    "command lines (T-161). Commands are incremental — one label added, one " +
    "assignee dropped — so a concurrent edit by someone else survives; " +
    "`PATCH issue` remains the whole-set replacement. Either the body or the " +
    "command list may be empty, not both. Any invalid id fails the whole " +
    "submission (422) and the comment is not created; a command whose effect " +
    "already holds succeeds without recording an event. No event type is " +
    "specific to commands: effects land the same closed / status_changed / " +
    "label_added / assigned events as any other path.",
  request: { params: issueParams, body: jsonBody(CommandSubmitInput) },
  responses: {
    200: { description: "Applied", ...jsonBody(CommandSubmitResult) },
  },
});

const getCommentRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/comments/{commentId}",
  summary: "Fetch one comment (permalink resolution)",
  request: { params: commentParams },
  responses: {
    200: { description: "Comment", ...jsonBody(TimelineComment) },
    ...movedResponses,
    ...strangerResponse,
  },
});

const locateCommentRoute = createRoute({
  method: "get",
  path: "/{slug}/comments/{commentId}",
  summary:
    "Resolve a comment id to the issue carrying it (bare #comment-M refs)",
  request: {
    params: z.object({
      slug: ProjectRef,
      commentId: z.coerce.number().int().positive(),
    }),
  },
  responses: {
    200: { description: "Comment", ...jsonBody(CommentLocation) },
    ...movedResponses,
    ...strangerResponse,
  },
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
  responses: {
    200: { description: "Page", ...jsonBody(RevisionPage) },
    ...movedResponses,
  },
});

const commentRevisionsRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/comments/{commentId}/revisions",
  summary: "Comment edit history, newest first, both sides paired",
  request: { params: commentParams, query: RevisionQuery },
  responses: {
    200: { description: "Page", ...jsonBody(RevisionPage) },
    ...movedResponses,
  },
});

const issueQuestionsRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/questions",
  summary:
    "Question comments of an issue with their answer status (T-19); powers " +
    "`todou question list/wait` and the web answer cards",
  request: { params: issueParams },
  responses: {
    200: { description: "Status", ...jsonBody(IssueQuestions) },
    ...movedResponses,
  },
});

const submitAnswersRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/comments/{commentId}/answers",
  summary:
    `Answer every question of a comment atomically ${roleTag("question.answer")}; ` +
    "one answer per comment, ever — answers cannot be edited",
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

  app.openapi(deleteIssueRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    await deleteIssue(
      c.get("appCtx"),
      c.get("user"),
      slug,
      number,
      c.get("agentContext"),
    );
    return c.body(null, 204);
  });

  app.openapi(moveIssueRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await moveIssue(
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

  app.openapi(restoreIssueRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await restoreIssue(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
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

  app.openapi(createCommandsRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await executeCommands(
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
