import type {
  AgentContext,
  ChangeEvent,
  CommentCreateInput,
  CommentUpdateInput,
  TimelineComment,
} from "@todou/shared";
import { and, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issues } from "../db/project-schema.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import { requireProject, routeInfoOf } from "./access.ts";
import { recordReferences } from "./references.ts";
import { getUserRefs } from "./users.ts";

type CommentRow = typeof comments.$inferSelect;

async function toTimelineComment(
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
    created_at: row.createdAt.toISOString(),
    edited_at: row.editedAt?.toISOString() ?? null,
    agent_context: row.agentContext ?? null,
  };
}

async function loadIssue(db: Db, projectId: number, number: number) {
  const rows = await db
    .select({ id: issues.id, number: issues.number })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
  const row = rows[0];
  if (!row) throw new NotFoundError("issue not found");
  return row;
}

export async function createComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: CommentCreateInput,
  agentContext: AgentContext | null = null,
): Promise<TimelineComment> {
  const { project } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);

  const events: ChangeEvent[] = [];
  const row = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(comments)
      .values({
        projectId: project.id,
        issueId: issue.id,
        authorId: actor.id,
        body: input.body,
        agentContext,
      })
      .returning();
    const comment = inserted[0];
    if (!comment) throw new Error("comment insert returned no row");

    events.push({
      entity: "timeline",
      id: comment.id,
      action: "created",
      issue_number: issueNumber,
    });

    const refs = await recordReferences(
      tx,
      project.id,
      actor.id,
      { issueNumber, commentId: comment.id },
      input.body,
      agentContext,
    );
    for (const ref of refs) {
      events.push({
        entity: "timeline",
        id: ref.eventId,
        action: "created",
        issue_number: ref.issueNumber,
      });
    }
    return comment;
  });

  for (const e of events) ctx.bus.publish(project.id, e);
  return toTimelineComment(ctx, row);
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
  const updated = await db
    .update(comments)
    .set({ body: input.body, editedAt: new Date() })
    .where(eq(comments.id, row.id))
    .returning();
  const after = updated[0];
  if (!after) throw new Error("comment update returned no row");

  const refs = await recordReferences(
    db,
    projectId,
    actor.id,
    { issueNumber, commentId: row.id },
    input.body,
    agentContext,
  );
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
  await db.delete(comments).where(eq(comments.id, row.id));
  ctx.bus.publish(projectId, {
    entity: "timeline",
    id: row.id,
    action: "deleted",
    issue_number: issueNumber,
  });
}
