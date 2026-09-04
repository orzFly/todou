import type {
  AgentContext,
  ChangeEvent,
  CommentComponent,
  CommentCreateInput,
  CommentCreateResult,
  CommentLocation,
  CommentUpdateInput,
  TimelineComment,
} from "@todou/shared";
import { formatRef, QuestionAnsweredPayload } from "@todou/shared";
import { and, eq, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import { CommentMovedError, ForbiddenError, NotFoundError } from "../errors.ts";
import { projectForRead, requireProject, routeInfoOf } from "./access.ts";
import {
  analyzeReferences,
  type CrossTarget,
  loadReferenceInputs,
  type ReferenceInputs,
  recordCrossReferences,
} from "./cross-references.ts";
import { encodeTimelineCursor } from "./cursor.ts";
import { canonicalizeComponent, questionCount } from "./questions.ts";
import { recordReferences, refPrefixAt } from "./references.ts";
import { aliasOf, originProjectFor } from "./relocation.ts";
import { deleteRevisionsFor, recordRevision } from "./revisions.ts";
import { microIso } from "./timeline.ts";
import {
  assertIssueReadable,
  assertIssueWritable,
  gateColumns,
} from "./trash.ts";
import { getUserRefs } from "./users.ts";

export type CommentRow = typeof comments.$inferSelect;

export async function toTimelineComment(
  ctx: AppContext,
  row: CommentRow,
): Promise<TimelineComment> {
  const refs = await getUserRefs(ctx.router.system(), [row.authorId]);
  const author = refs.get(row.authorId);
  if (!author) throw new Error("author ref missing");
  return {
    type: "comment",
    id: row.id,
    author,
    body: row.body,
    component: row.component ?? null,
    created_at: row.createdAt.toISOString(),
    edited_at: row.editedAt?.toISOString() ?? null,
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    agent_context: row.agentContext ?? null,
  };
}

async function loadIssue(db: Db, projectId: number, number: number) {
  const rows = await db
    .select({
      ...gateColumns,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
  const row = rows[0];
  if (!row) throw new NotFoundError("issue not found");
  return row;
}

/**
 * Insert a comment row inside an open transaction: the row itself, the
 * issue's `updated_at` (plus the open-question counter), the reference scan
 * and the timeline ChangeEvents it produces. Shared by `createComment` and
 * the atomic command endpoint (T-161), which needs a comment and a set of
 * field changes to land or roll back together.
 *
 * `refInputs` is a parameter because it reads the system database, which a
 * project transaction must not hold a second connection for — the caller
 * loads it before opening the transaction.
 */
export async function insertCommentInTx(
  tx: Db,
  args: {
    project: { id: number; slug: string };
    issue: { id: number; number: number };
    actorId: number;
    body: string;
    component?: CommentComponent | null;
    agentContext: AgentContext | null;
    refInputs: ReferenceInputs;
  },
): Promise<{
  comment: CommentRow;
  /** Publish after commit; the comment leads, subscribers pin that. */
  timeline: ChangeEvent[];
  crossTargets: CrossTarget[];
}> {
  const { project, issue, actorId, body, agentContext, refInputs } = args;
  const component = args.component ?? null;
  const issueNumber = issue.number;

  const inserted = await tx
    .insert(comments)
    .values({
      projectId: project.id,
      issueId: issue.id,
      authorId: actorId,
      body,
      component,
      agentContext,
    })
    .returning();
  const comment = inserted[0];
  if (!comment) throw new Error("comment insert returned no row");

  const asked = questionCount(component);
  await tx
    .update(issues)
    .set(
      asked > 0
        ? {
            openQuestions: sql`${issues.openQuestions} + ${asked}`,
            updatedAt: new Date(),
          }
        : { updatedAt: new Date() },
    )
    .where(eq(issues.id, issue.id));

  const timeline: ChangeEvent[] = [
    {
      entity: "timeline",
      id: comment.id,
      action: "created",
      issue_number: issueNumber,
    },
  ];

  const analyzed = await analyzeReferences(
    tx,
    refInputs,
    project,
    body,
    comment.createdAt,
    { issueNumber, commentId: comment.id },
  );
  const refs = await recordReferences(
    tx,
    project.id,
    actorId,
    { issueNumber, commentId: comment.id },
    analyzed.local,
    agentContext,
  );
  for (const ref of refs) {
    timeline.push({
      entity: "timeline",
      id: ref.eventId,
      action: "created",
      issue_number: ref.issueNumber,
    });
  }
  return { comment, timeline, crossTargets: analyzed.cross };
}

export async function createComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: CommentCreateInput,
  agentContext: AgentContext | null = null,
): Promise<CommentCreateResult> {
  const { project, role } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueWritable(issue, actor, role);

  const component =
    input.component === undefined
      ? null
      : canonicalizeComponent(input.component);

  const refInputs = await loadReferenceInputs(ctx, db, project.id);
  let crossTargets: CrossTarget[] = [];
  const events: ChangeEvent[] = [];
  const { row, ts } = await db.transaction(async (tx) => {
    const result = await insertCommentInTx(tx, {
      project,
      issue: { id: issue.id, number: issueNumber },
      actorId: actor.id,
      body: input.body,
      component,
      agentContext,
      refInputs,
    });
    crossTargets = result.crossTargets;
    events.push(...result.timeline);
    // updated_at moved (and maybe the counter) → issue list ordering and
    // badges must refresh.
    events.push({
      entity: "issue",
      id: issue.id,
      action: "updated",
      issue_number: issueNumber,
    });
    // Read back at µs precision rather than reusing the row's Date, which
    // holds milliseconds: a cursor that cannot separate two entries of the
    // same millisecond either repeats one or drops one.
    const [position] = await tx
      .select({ ts: microIso(comments.createdAt) })
      .from(comments)
      .where(eq(comments.id, result.comment.id));
    if (!position) throw new Error("comment row vanished mid-insert");
    return { row: result.comment, ts: position.ts };
  });

  for (const e of events) ctx.bus.publish(project.id, e);
  await recordCrossReferences(
    ctx,
    actor,
    project,
    { issueNumber, commentId: row.id },
    crossTargets,
    agentContext,
  );
  return {
    ...(await toTimelineComment(ctx, row)),
    // The comment's own position: what follows it is the answer to it,
    // and the comment itself is already in the caller's hands (T-182).
    cursor: encodeTimelineCursor({ t: ts, k: 0, i: row.id }),
  };
}

/** Fetch one comment by id, scoped to its issue (permalink resolution). */
export async function getComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
): Promise<TimelineComment> {
  // A permalink is written down and followed later, so it answers to
  // whoever can read where the comment is now (T-242).
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueReadable(issue, actor, role);

  const rows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.issueId, issue.id)));
  const row = rows[0];
  if (!row) await throwIfAliased(ctx, project.id, commentId, role !== null);
  if (!row) throw new NotFoundError("comment not found");
  return toTimelineComment(ctx, row);
}

/**
 * A comment id that is not here may be one this project used to hold before
 * the card moved (T-231). Checked only on a miss, so the common path never
 * touches the system database.
 */
async function throwIfAliased(
  ctx: AppContext,
  projectId: number,
  commentId: number,
  sourceReadable: boolean,
): Promise<void> {
  const alias = await aliasOf(
    ctx.router.system(),
    "comment",
    projectId,
    commentId,
  );
  if (alias !== null) {
    throw new CommentMovedError(projectId, commentId, sourceReadable);
  }
}

/**
 * Resolve a comment without knowing which issue carries it — the entry
 * point for a bare `#comment-M` reference (T-150), where the id is all the
 * author wrote.
 */
export async function locateComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  commentId: number,
): Promise<CommentLocation> {
  // Same as getComment: a bare `#comment-M` outlives the move that carried
  // the comment away, so the destination decides who may follow it (T-242).
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select({
      comment: comments,
      ...gateColumns,
    })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(and(eq(comments.projectId, project.id), eq(comments.id, commentId)));
  const row = rows[0];
  if (!row) await throwIfAliased(ctx, project.id, commentId, role !== null);
  if (!row) throw new NotFoundError("comment not found");
  // This endpoint reaches a comment by id alone, so the issue's own gate
  // never ran: without this, a bare `#comment-M` would hand out the body of
  // a comment on a deleted card.
  assertIssueReadable(row, actor, role);
  // The ref is a label for the reader, so it is spelled in the format in
  // force now — not the one the comment was written under (T-80).
  const prefix = await refPrefixAt(db, project.id, new Date());
  return {
    issue_number: row.number,
    issue_ref: formatRef(prefix, row.number),
    comment: await toTimelineComment(ctx, row.comment),
  };
}

async function loadCommentForWrite(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
): Promise<{ projectId: number; db: Db; row: CommentRow }> {
  const { project, role } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueWritable(issue, actor, role);

  const rows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.issueId, issue.id)));
  const row = rows[0];
  if (!row) throw new NotFoundError("comment not found");
  if (row.authorId !== actor.id && role !== "admin") {
    throw new ForbiddenError("only the author or a project admin may modify");
  }
  return { projectId: project.id, db, row };
}

export async function updateComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
  input: CommentUpdateInput,
  // The comment row keeps its original provenance; only the referenced
  // events born from this edit carry the editing request's context.
  agentContext: AgentContext | null = null,
): Promise<TimelineComment> {
  const { projectId, db, row } = await loadCommentForWrite(
    ctx,
    actor,
    slug,
    issueNumber,
    commentId,
  );
  // No-op saves succeed but record nothing: no revision, no edited_at
  // bump, no SSE, no reference re-scan.
  if (input.body === row.body) return toTimelineComment(ctx, row);

  const project = { id: projectId, slug };
  const refInputs = await loadReferenceInputs(ctx, db, projectId);
  // The comment may predate a move, and its text was never rewritten.
  const origin = await originProjectFor(
    ctx,
    db,
    project,
    row.issueId,
    row.createdAt,
  );
  let crossTargets: CrossTarget[] = [];
  const { after, refs } = await db.transaction(async (tx) => {
    const updated = await tx
      .update(comments)
      .set({ body: input.body, editedAt: new Date() })
      .where(eq(comments.id, row.id))
      .returning();
    const after = updated[0];
    if (!after) throw new Error("comment update returned no row");

    await recordRevision(tx, {
      projectId,
      subjectType: "comment",
      subjectId: row.id,
      body: row.body,
      actorId: actor.id,
      agentContext,
    });

    // An origin project that no longer exists leaves this text's numbering
    // unresolvable, so it records nothing: see originProjectFor.
    const analyzed =
      origin === null
        ? { local: [], cross: [] }
        : await analyzeReferences(
            tx,
            refInputs,
            project,
            input.body,
            row.createdAt,
            { issueNumber, commentId: row.id },
            origin,
          );
    crossTargets = analyzed.cross;
    const refs = await recordReferences(
      tx,
      projectId,
      actor.id,
      { issueNumber, commentId: row.id },
      analyzed.local,
      agentContext,
    );
    return { after, refs };
  });
  ctx.bus.publish(projectId, {
    entity: "timeline",
    id: row.id,
    action: "updated",
    issue_number: issueNumber,
  });
  for (const ref of refs) {
    ctx.bus.publish(projectId, {
      entity: "timeline",
      id: ref.eventId,
      action: "created",
      issue_number: ref.issueNumber,
    });
  }
  await recordCrossReferences(
    ctx,
    actor,
    project,
    { issueNumber, commentId: row.id },
    crossTargets,
    agentContext,
  );
  return toTimelineComment(ctx, after);
}

export async function deleteComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
): Promise<void> {
  const { projectId, db, row } = await loadCommentForWrite(
    ctx,
    actor,
    slug,
    issueNumber,
    commentId,
  );
  let counterChanged = false;
  await db.transaction(async (tx) => {
    // A still-unresolved spec comment gives its count back (T-23); a
    // resolved one already surrendered it at resolve time.
    if (row.component?.type === "spec_comment" && row.resolvedAt === null) {
      await tx
        .update(issues)
        .set({
          specUnresolvedComments: sql`greatest(${issues.specUnresolvedComments} - 1, 0)`,
        })
        .where(eq(issues.id, row.issueId));
      counterChanged = true;
    }
    // A still-unanswered question comment gives its count back; an answered
    // one already surrendered it when the answer landed.
    const asked = questionCount(row.component);
    if (asked > 0) {
      const answered = (
        await tx
          .select({ payload: issueEvents.payload })
          .from(issueEvents)
          .where(
            and(
              eq(issueEvents.issueId, row.issueId),
              eq(issueEvents.type, "question_answered"),
            ),
          )
      ).some((e) => {
        const parsed = QuestionAnsweredPayload.safeParse(e.payload);
        return parsed.success && parsed.data.comment_id === row.id;
      });
      if (!answered) {
        await tx
          .update(issues)
          .set({
            openQuestions: sql`greatest(${issues.openQuestions} - ${asked}, 0)`,
          })
          .where(eq(issues.id, row.issueId));
        counterChanged = true;
      }
    }
    await tx.delete(comments).where(eq(comments.id, row.id));
    await deleteRevisionsFor(tx, projectId, "comment", row.id);
  });
  ctx.bus.publish(projectId, {
    entity: "timeline",
    id: row.id,
    action: "deleted",
    issue_number: issueNumber,
  });
  if (counterChanged) {
    ctx.bus.publish(projectId, {
      entity: "issue",
      id: row.issueId,
      action: "updated",
      issue_number: issueNumber,
    });
  }
}
