import type {
  AgentContext,
  Revision,
  RevisionPage,
  RevisionQuery,
  UserRef,
} from "@todou/shared";
import { and, desc, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issues, revisions } from "../db/project-schema.ts";
import { NotFoundError } from "../errors.ts";
import { requireProject, routeInfoOf } from "./access.ts";
import { getUserRefs } from "./users.ts";

export type RevisionSubjectType =
  (typeof revisions.$inferSelect)["subjectType"];

/**
 * Record one content-changing edit: the caller has already established
 * that the new text differs and passes the superseded (pre-edit) body.
 * Runs on the caller's transaction so the snapshot and the content update
 * commit together.
 */
export async function recordRevision(
  db: Db,
  input: {
    projectId: number;
    subjectType: RevisionSubjectType;
    subjectId: number;
    body: string;
    actorId: number;
    agentContext: AgentContext | null;
  },
): Promise<void> {
  await db.insert(revisions).values(input);
}

/** Revisions have no FK to their subject; owning services cascade by hand. */
export async function deleteRevisionsFor(
  db: Db,
  projectId: number,
  subjectType: RevisionSubjectType,
  subjectId: number,
): Promise<void> {
  await db
    .delete(revisions)
    .where(
      and(
        eq(revisions.projectId, projectId),
        eq(revisions.subjectType, subjectType),
        eq(revisions.subjectId, subjectId),
      ),
    );
}

/**
 * Newest-first edit list with both sides paired: each stored row is the
 * text BEFORE its edit, so row 0's after-side is the live content and row
 * n's after-side is row n-1's snapshot. A `limit` therefore only drops
 * older edits whole — every returned pair is complete.
 */
async function listRevisions(
  ctx: AppContext,
  db: Db,
  input: {
    projectId: number;
    subjectType: RevisionSubjectType;
    subjectId: number;
    currentBody: string;
    limit: number;
  },
): Promise<Revision[]> {
  const rows = await db
    .select()
    .from(revisions)
    .where(
      and(
        eq(revisions.projectId, input.projectId),
        eq(revisions.subjectType, input.subjectType),
        eq(revisions.subjectId, input.subjectId),
      ),
    )
    .orderBy(desc(revisions.id))
    .limit(input.limit);

  const refs = await getUserRefs(
    ctx.router.system(),
    rows.map((r) => r.actorId),
  );
  const ghost = (id: number): UserRef => ({
    id,
    login: "ghost",
    display_name: "Deleted user",
    kind: "human",
    avatar_url: null,
    owner: null,
  });

  // Walking newest → oldest, each edit's after-side is what the previous
  // (newer) edit replaced — seeded by the live content.
  let after = input.currentBody;
  const items: Revision[] = [];
  for (const row of rows) {
    items.push({
      id: row.id,
      actor: refs.get(row.actorId) ?? ghost(row.actorId),
      created_at: row.createdAt.toISOString(),
      body_before: row.body,
      body_after: after,
      agent_context: row.agentContext ?? null,
    });
    after = row.body;
  }
  return items;
}

export async function listIssueRevisions(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  query: RevisionQuery,
): Promise<RevisionPage> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const issueRows = await db
    .select({ id: issues.id, body: issues.body })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");

  const items = await listRevisions(ctx, db, {
    projectId: project.id,
    subjectType: "issue_body",
    subjectId: issue.id,
    currentBody: issue.body,
    limit: query.limit,
  });
  return { items };
}

export async function listCommentRevisions(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
  query: RevisionQuery,
): Promise<RevisionPage> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const issueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");

  const commentRows = await db
    .select({ id: comments.id, body: comments.body })
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.issueId, issue.id)));
  const comment = commentRows[0];
  if (!comment) throw new NotFoundError("comment not found");

  const items = await listRevisions(ctx, db, {
    projectId: project.id,
    subjectType: "comment",
    subjectId: comment.id,
    currentBody: comment.body,
    limit: query.limit,
  });
  return { items };
}
