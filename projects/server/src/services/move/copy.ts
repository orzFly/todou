import { and, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../../db/driver.ts";
import {
  attachments,
  comments,
  issueAssignees,
  issueEvents,
  issueLabels,
  issueReads,
  issues,
  pendingUploads,
  revisions,
  specVersionFiles,
  specVersions,
} from "../../db/project-schema.ts";
import { microIso } from "../timeline.ts";

/** Rows per read; a card's spec files are the reason this is not unbounded. */
const BATCH = 500;

export type IdMap = {
  issueId: number;
  /** Old comment id → new. Also what the `moved_ids` aliases are built from. */
  comments: Map<number, number>;
  attachments: Map<number, number>;
};

/**
 * Every table hanging off an issue, and what a move does with it.
 *
 * One list, walked twice: once to copy into the destination and once to
 * clear the source. Keeping them on the same list is the point — the source
 * row survives as a tombstone, so none of these cascade, and a table missed
 * on the delete side leaves rows under a tombstone forever.
 *
 * `issue_reads` and `pending_uploads` are on the list precisely because they
 * are NOT copied: a read position is per reader and does not follow a card
 * across projects, and an upload in flight cannot complete against a frozen
 * card anyway. Both still have to be deleted. Dropping the object behind a
 * pending upload is not this code's job — it never became an attachment, and
 * `gcPendingUploads` collects it on expiry exactly as before.
 */
export const ISSUE_CHILD_TABLES: ReadonlyArray<{
  name: string;
  copied: boolean;
  clearSource(db: Db, issueId: number): Promise<unknown>;
}> = [
  {
    name: "issue_assignees",
    copied: true,
    clearSource: (db, id) =>
      db.delete(issueAssignees).where(eq(issueAssignees.issueId, id)),
  },
  {
    name: "issue_labels",
    copied: true,
    clearSource: (db, id) =>
      db.delete(issueLabels).where(eq(issueLabels.issueId, id)),
  },
  {
    name: "comments",
    copied: true,
    clearSource: (db, id) =>
      db.delete(comments).where(eq(comments.issueId, id)),
  },
  {
    name: "issue_events",
    copied: true,
    // Including any `moved_out` a previous attempt wrote: the replacement is
    // inserted after this runs, so a replay still leaves exactly one.
    clearSource: (db, id) =>
      db.delete(issueEvents).where(eq(issueEvents.issueId, id)),
  },
  {
    name: "spec_version_files",
    copied: true,
    // Hangs off the version, not the issue; deleted first for that reason.
    clearSource: (db, id) =>
      db
        .delete(specVersionFiles)
        .where(
          inArray(
            specVersionFiles.versionId,
            db
              .select({ id: specVersions.id })
              .from(specVersions)
              .where(eq(specVersions.issueId, id)),
          ),
        ),
  },
  {
    name: "spec_versions",
    copied: true,
    clearSource: (db, id) =>
      db.delete(specVersions).where(eq(specVersions.issueId, id)),
  },
  {
    name: "attachments",
    copied: true,
    clearSource: (db, id) =>
      db.delete(attachments).where(eq(attachments.issueId, id)),
  },
  {
    name: "revisions",
    copied: true,
    clearSource: async (db, id) => {
      const commentIds = await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.issueId, id));
      await db
        .delete(revisions)
        .where(
          and(
            eq(revisions.subjectType, "issue_body"),
            eq(revisions.subjectId, id),
          ),
        );
      if (commentIds.length > 0) {
        await db.delete(revisions).where(
          and(
            eq(revisions.subjectType, "comment"),
            inArray(
              revisions.subjectId,
              commentIds.map((c) => c.id),
            ),
          ),
        );
      }
    },
  },
  {
    name: "issue_reads",
    copied: false,
    clearSource: (db, id) =>
      db.delete(issueReads).where(eq(issueReads.issueId, id)),
  },
  {
    name: "pending_uploads",
    copied: false,
    clearSource: (db, id) =>
      db.delete(pendingUploads).where(eq(pendingUploads.issueId, id)),
  },
];

/**
 * Delete every child row of a source issue, leaving the tombstone bare.
 * Walks the same list the copy does, so the two cannot drift apart.
 *
 * Revisions come before comments: they are found through the comment rows
 * they belong to, which a polymorphic subject gives them no foreign key for.
 */
export async function clearIssueChildren(
  db: Db,
  issueId: number,
): Promise<void> {
  const ordered = [...ISSUE_CHILD_TABLES].sort((a, b) =>
    a.name === "revisions" ? -1 : b.name === "revisions" ? 1 : 0,
  );
  for (const table of ordered) await table.clearSource(db, issueId);
}

/**
 * `created_at` and friends at full microsecond precision. The driver's Date
 * only holds milliseconds, and the timeline cursor is
 * `(created_at µs, kind, id)` — a copy that rounds would reorder the card's
 * own history against cursors clients already hold.
 */
const micro = (column: AnyPgColumn) => microIso(column);

/** The reverse: microsecond text back into a timestamptz, nulls preserved. */
const atMicro = (text: string | null) =>
  text === null ? null : sql`${text}::timestamptz`;

type Payload = Record<string, unknown>;

/**
 * Copy an issue and everything under it into the destination database.
 *
 * Returns the id map, which the caller also writes into the `moved_in`
 * payload: across databases that event is the only durable record of which
 * copy became which, and the recovery sweep has nothing else to go on.
 */
export async function copyIssueTree(
  src: Db,
  dst: Db,
  plan: {
    row: typeof issues.$inferSelect;
    source: { project: { id: number } };
    target: { project: { id: number } };
    status: { to: { id: number } };
    labelIds: number[];
    assigneeIds: number[];
    movedAt: Date;
    sameProjectDb: boolean;
  },
  opts: { number: number; reinhabit: boolean },
): Promise<IdMap> {
  const sourceId = plan.source.project.id;
  const targetId = plan.target.project.id;
  const oldIssueId = plan.row.id;

  const [stamps] = await src
    .select({
      createdAt: micro(issues.createdAt),
      bodyEditedAt: micro(issues.bodyEditedAt),
    })
    .from(issues)
    .where(eq(issues.id, oldIssueId));
  if (stamps === undefined) throw new Error("issue row vanished mid-copy");

  const fields = {
    projectId: targetId,
    number: opts.number,
    title: plan.row.title,
    body: plan.row.body,
    statusId: plan.status.to.id,
    authorId: plan.row.authorId,
    createdAt: atMicro(stamps.createdAt),
    // A move is activity: the card belongs at the top of its new list.
    updatedAt: plan.movedAt,
    bodyEditedAt: atMicro(stamps.bodyEditedAt),
    openQuestions: plan.row.openQuestions,
    specVersion: plan.row.specVersion,
    specReviewStatus: plan.row.specReviewStatus,
    specUnresolvedComments: plan.row.specUnresolvedComments,
    deletedAt: null,
    deletedBy: null,
    movingSince: null,
    movedAt: null,
    // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs stamps
  } as any;

  let issueId: number;
  if (opts.reinhabit) {
    // Moving back in: the tombstone already holds this number, so the copy
    // lands on that row rather than colliding with it.
    const updated = await dst
      .update(issues)
      .set(fields)
      .where(
        and(eq(issues.projectId, targetId), eq(issues.number, opts.number)),
      )
      .returning({ id: issues.id });
    const id = updated[0]?.id;
    if (id === undefined) throw new Error("no tombstone to move back into");
    issueId = id;
    await clearIssueChildren(dst, issueId);
  } else {
    const inserted = await dst.insert(issues).values(fields).returning({
      id: issues.id,
    });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("issue copy returned no row");
    issueId = id;
  }

  if (plan.assigneeIds.length > 0) {
    await dst
      .insert(issueAssignees)
      .values(plan.assigneeIds.map((userId) => ({ issueId, userId })));
  }
  if (plan.labelIds.length > 0) {
    await dst
      .insert(issueLabels)
      .values(plan.labelIds.map((labelId) => ({ issueId, labelId })));
  }

  const commentMap = await copyComments(src, dst, {
    sourceId,
    targetId,
    oldIssueId,
    issueId,
  });
  const specMap = await copySpecVersions(src, dst, {
    sourceId,
    targetId,
    oldIssueId,
    issueId,
  });
  await copySpecFiles(src, dst, { sourceId, targetId, specMap });
  const attachmentMap = await copyAttachments(src, dst, {
    sourceId,
    targetId,
    oldIssueId,
    issueId,
    deleteSourceFirst: plan.sameProjectDb,
  });
  await copyRevisions(src, dst, {
    sourceId,
    targetId,
    oldIssueId,
    issueId,
    commentMap,
  });
  await copyEvents(src, dst, {
    sourceId,
    targetId,
    oldIssueId,
    issueId,
    commentMap,
    attachmentMap,
  });

  return { issueId, comments: commentMap, attachments: attachmentMap };
}

/**
 * Rows are inserted one at a time on purpose. A multi-row insert would have
 * to pair the ids it gets back by position, and `RETURNING` is under no
 * obligation to preserve the order rows were supplied in — a mispairing here
 * produces no error at all, just permalinks that quietly land on the wrong
 * comment.
 */
async function copyComments(
  src: Db,
  dst: Db,
  ids: {
    sourceId: number;
    targetId: number;
    oldIssueId: number;
    issueId: number;
  },
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for await (const batch of readBatches(src, comments, ids.oldIssueId, {
    id: comments.id,
    authorId: comments.authorId,
    body: comments.body,
    component: comments.component,
    agentContext: comments.agentContext,
    resolvedBy: comments.resolvedBy,
    createdAt: micro(comments.createdAt),
    editedAt: micro(comments.editedAt),
    resolvedAt: micro(comments.resolvedAt),
  })) {
    for (const row of batch) {
      const inserted = await dst
        .insert(comments)
        .values({
          projectId: ids.targetId,
          issueId: ids.issueId,
          authorId: row.authorId,
          body: row.body,
          component: row.component,
          agentContext: row.agentContext,
          resolvedBy: row.resolvedBy,
          createdAt: atMicro(row.createdAt),
          editedAt: atMicro(row.editedAt),
          resolvedAt: atMicro(row.resolvedAt),
          // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
        } as any)
        .returning({ id: comments.id });
      const id = inserted[0]?.id;
      if (id === undefined) throw new Error("comment copy returned no row");
      map.set(row.id, id);
    }
  }
  return map;
}

async function copyAttachments(
  src: Db,
  dst: Db,
  ids: {
    sourceId: number;
    targetId: number;
    oldIssueId: number;
    issueId: number;
    deleteSourceFirst: boolean;
  },
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const rows: Array<{
    id: number;
    uploaderId: number;
    filename: string;
    contentType: string;
    size: number;
    storageKey: string;
    createdAt: string | null;
  }> = [];
  for await (const batch of readBatches(src, attachments, ids.oldIssueId, {
    id: attachments.id,
    uploaderId: attachments.uploaderId,
    filename: attachments.filename,
    contentType: attachments.contentType,
    size: attachments.size,
    storageKey: attachments.storageKey,
    createdAt: micro(attachments.createdAt),
  })) {
    rows.push(...batch);
  }
  if (rows.length === 0) return map;

  // The blob is not copied, so the copy keeps the same storage key — and
  // `attachments_storage_key_idx` is unique per DATABASE, not per project.
  // Where both projects live in one database the source rows have to go
  // first, or the copy collides with the rows it is copying.
  if (ids.deleteSourceFirst) {
    await src
      .delete(attachments)
      .where(eq(attachments.issueId, ids.oldIssueId));
  }

  for (const row of rows) {
    const inserted = await dst
      .insert(attachments)
      .values({
        projectId: ids.targetId,
        issueId: ids.issueId,
        uploaderId: row.uploaderId,
        filename: row.filename,
        contentType: row.contentType,
        size: row.size,
        storageKey: row.storageKey,
        createdAt: atMicro(row.createdAt),
        // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
      } as any)
      .returning({ id: attachments.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("attachment copy returned no row");
    map.set(row.id, id);
  }
  return map;
}

async function copySpecVersions(
  src: Db,
  dst: Db,
  ids: {
    sourceId: number;
    targetId: number;
    oldIssueId: number;
    issueId: number;
  },
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for await (const batch of readBatches(src, specVersions, ids.oldIssueId, {
    id: specVersions.id,
    number: specVersions.number,
    authorId: specVersions.authorId,
    message: specVersions.message,
    agentContext: specVersions.agentContext,
    createdAt: micro(specVersions.createdAt),
  })) {
    for (const row of batch) {
      const inserted = await dst
        .insert(specVersions)
        .values({
          projectId: ids.targetId,
          issueId: ids.issueId,
          number: row.number,
          authorId: row.authorId,
          message: row.message,
          agentContext: row.agentContext,
          createdAt: atMicro(row.createdAt),
          // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
        } as any)
        .returning({ id: specVersions.id });
      const id = inserted[0]?.id;
      if (id === undefined)
        throw new Error("spec version copy returned no row");
      map.set(row.id, id);
    }
  }
  return map;
}

async function copySpecFiles(
  src: Db,
  dst: Db,
  ids: { sourceId: number; targetId: number; specMap: Map<number, number> },
): Promise<void> {
  if (ids.specMap.size === 0) return;
  const oldVersionIds = [...ids.specMap.keys()];
  for (let i = 0; i < oldVersionIds.length; i += BATCH) {
    const slice = oldVersionIds.slice(i, i + BATCH);
    const rows = await src
      .select()
      .from(specVersionFiles)
      .where(inArray(specVersionFiles.versionId, slice));
    if (rows.length === 0) continue;
    await dst.insert(specVersionFiles).values(
      rows.map((row) => ({
        projectId: ids.targetId,
        versionId: ids.specMap.get(row.versionId) as number,
        path: row.path,
        body: row.body,
        size: row.size,
      })),
    );
  }
}

async function copyRevisions(
  src: Db,
  dst: Db,
  ids: {
    sourceId: number;
    targetId: number;
    oldIssueId: number;
    issueId: number;
    commentMap: Map<number, number>;
  },
): Promise<void> {
  const subjects: Array<{ type: "issue_body" | "comment"; oldId: number }> = [
    { type: "issue_body", oldId: ids.oldIssueId },
    ...[...ids.commentMap.keys()].map(
      (oldId) => ({ type: "comment", oldId }) as const,
    ),
  ];
  for (const subject of subjects) {
    const rows = await src
      .select({
        body: revisions.body,
        actorId: revisions.actorId,
        agentContext: revisions.agentContext,
        createdAt: micro(revisions.createdAt),
      })
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, ids.sourceId),
          eq(revisions.subjectType, subject.type),
          eq(revisions.subjectId, subject.oldId),
        ),
      );
    if (rows.length === 0) continue;
    const newSubjectId =
      subject.type === "issue_body"
        ? ids.issueId
        : (ids.commentMap.get(subject.oldId) as number);
    await dst.insert(revisions).values(
      rows.map(
        (row) =>
          ({
            projectId: ids.targetId,
            subjectType: subject.type,
            subjectId: newSubjectId,
            body: row.body,
            actorId: row.actorId,
            agentContext: row.agentContext,
            createdAt: atMicro(row.createdAt),
            // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
          }) as any,
      ),
    );
  }
}

async function copyEvents(
  src: Db,
  dst: Db,
  ids: {
    sourceId: number;
    targetId: number;
    oldIssueId: number;
    issueId: number;
    commentMap: Map<number, number>;
    attachmentMap: Map<number, number>;
  },
): Promise<void> {
  for await (const batch of readBatches(src, issueEvents, ids.oldIssueId, {
    id: issueEvents.id,
    actorId: issueEvents.actorId,
    type: issueEvents.type,
    payload: issueEvents.payload,
    agentContext: issueEvents.agentContext,
    createdAt: micro(issueEvents.createdAt),
  })) {
    const values = batch.map((row) => ({
      projectId: ids.targetId,
      issueId: ids.issueId,
      actorId: row.actorId,
      type: row.type,
      payload: remapPayload(row.type, row.payload as Payload, ids),
      agentContext: row.agentContext,
      createdAt: atMicro(row.createdAt),
    }));
    if (values.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
      await dst.insert(issueEvents).values(values as any);
    }
  }
}

/**
 * Rewrite the row ids our own event payloads carry. Not a general rule — the
 * exhaustive list is short, and getting it wrong is silent, so it is spelled
 * out rather than inferred.
 *
 * `by_comment` on a reference event is deliberately absent: on this card's
 * own timeline it names the comment that did the referencing, which belongs
 * to some other card and does not move.
 */
export function remapPayload(
  type: string,
  payload: Payload,
  ids: { commentMap: Map<number, number>; attachmentMap: Map<number, number> },
): Payload {
  const comment = (id: unknown) =>
    typeof id === "number" ? (ids.commentMap.get(id) ?? id) : id;
  switch (type) {
    case "question_answered":
    case "spec_review":
      return { ...payload, comment_id: comment(payload.comment_id) };
    case "spec_comments_resolved":
      return {
        ...payload,
        comment_ids: Array.isArray(payload.comment_ids)
          ? payload.comment_ids.map(comment)
          : payload.comment_ids,
      };
    case "attachment_added": {
      const attachment = payload.attachment as { id?: unknown } | undefined;
      if (attachment?.id === undefined) return payload;
      return {
        ...payload,
        attachment: {
          ...attachment,
          id:
            typeof attachment.id === "number"
              ? (ids.attachmentMap.get(attachment.id) ?? attachment.id)
              : attachment.id,
        },
      };
    }
    default:
      return payload;
  }
}

/** Read one issue's rows from a table in id order, `BATCH` at a time. */
async function* readBatches(
  db: Db,
  // biome-ignore lint/suspicious/noExplicitAny: any project-tier child table
  table: any,
  issueId: number,
  // biome-ignore lint/suspicious/noExplicitAny: a drizzle selection object
  selection: any,
  // biome-ignore lint/suspicious/noExplicitAny: mirrors `selection`
): AsyncGenerator<any[]> {
  let after = 0;
  for (;;) {
    const rows = await db
      .select(selection)
      .from(table)
      .where(and(eq(table.issueId, issueId), sql`${table.id} > ${after}`))
      .orderBy(table.id)
      .limit(BATCH);
    if (rows.length === 0) return;
    yield rows;
    const last = rows.at(-1) as { id?: number } | undefined;
    if (last?.id === undefined) return;
    after = last.id;
  }
}
