import { randomUUID } from "node:crypto";
import {
  type AgentContext,
  type Attachment,
  type AttachmentAlias,
  type AttachmentReference,
  type ChangeEvent,
  can,
  type DeletedAttachment,
  type DirectUploadRequest,
  type DirectUploadTicket,
  formatRef,
  minRoleOf,
} from "@todou/shared";
import { and, asc, eq, inArray, isNull, like } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import { uniqueViolation } from "../auth/provision.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  attachments,
  comments,
  issueEvents,
  issues,
  pendingUploads,
} from "../db/project-schema.ts";
import { projects } from "../db/system-schema.ts";
import {
  AttachmentMovedError,
  ConflictError,
  DirectUploadIncompleteError,
  DirectUploadUnavailableError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { S3Storage } from "../storage/s3.ts";
import {
  type ProjectRow,
  projectForRead,
  requireCapability,
  routeInfoOf,
} from "./access.ts";
import { linkedAttachmentIds } from "./attachment-links.ts";
import {
  encodeNameSegment,
  nameKey,
  resolveCollision,
  sanitizeFilename,
  takenNames,
} from "./attachment-names.ts";
import { visibleProjects } from "./cross-references.ts";
import { formerSlugsOf } from "./projects.ts";
import { currentRefPrefix } from "./references.ts";
import { aliasAddressesOf, aliasOf } from "./relocation.ts";
import {
  assertIssueReadable,
  assertIssueWritable,
  gateColumns,
} from "./trash.ts";
import { getUserRefs } from "./users.ts";

type AttachmentRow = typeof attachments.$inferSelect;

async function toAttachment(
  ctx: AppContext,
  slug: string,
  row: AttachmentRow,
): Promise<Attachment> {
  const refs = await getUserRefs(ctx.router.system(), [row.uploaderId]);
  const uploader = refs.get(row.uploaderId);
  if (!uploader) throw new Error("uploader ref missing");
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.contentType,
    size: row.size,
    url: `/api/projects/${slug}/attachments/${row.id}/download/${encodeNameSegment(row.filename)}`,
    uploader,
    created_at: row.createdAt.toISOString(),
    // Only the list endpoint pays for the address book; an upload's response
    // describes a file that has not been anywhere else yet.
    aliases: [],
  };
}

export async function uploadAttachment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  file: File,
  agentContext: AgentContext | null = null,
  draft = false,
): Promise<Attachment> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "attachment.upload",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  const maxBytes = ctx.config.storage.max_upload_mb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new ValidationFailedError(
      `file exceeds the ${ctx.config.storage.max_upload_mb} MB upload limit`,
    );
  }

  const issueRows = await db
    .select({
      ...gateColumns,
    })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");
  assertIssueWritable(issue, actor, role);

  const storageKey = newStorageKey();
  await ctx.storage.put(storageKey, new Uint8Array(await file.arrayBuffer()));

  const requested = sanitizeFilename(file.name);
  const row = await retryNaming(() =>
    db.transaction(async (tx) => {
      const attachment = await insertNamed(tx, requested, {
        projectId: project.id,
        issueId: issue.id,
        uploaderId: actor.id,
        contentType: file.type || "application/octet-stream",
        size: file.size,
        storageKey,
        draft,
      });
      if (!draft) await announceInTx(tx, attachment, actor.id, agentContext);
      return attachment;
    }),
  );

  if (!draft) {
    publishAttachmentEvents(ctx, project.id, row.id, issue.id, issueNumber);
  }
  return toAttachment(ctx, slug, row);
}

/**
 * What makes a file part of the card: the `attachment_added` event and the
 * card's activity bump. An upload does this at once; a draft (T-568) only
 * when a text that links it is written, so a file whose comment never went
 * out never told anyone it existed.
 */
async function announceInTx(
  tx: Db,
  attachment: AttachmentRow,
  actorId: number,
  agentContext: AgentContext | null,
): Promise<void> {
  await tx.insert(issueEvents).values({
    projectId: attachment.projectId,
    issueId: attachment.issueId,
    actorId,
    type: "attachment_added",
    agentContext,
    payload: {
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        size: attachment.size,
      },
    },
  });
  await tx
    .update(issues)
    .set({ updatedAt: new Date() })
    .where(eq(issues.id, attachment.issueId));
}

function newStorageKey(): string {
  const uuid = randomUUID();
  return `${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
}

/**
 * Insert the row under a name free on this card (T-269).
 *
 * The colliding case needs the row's own id, which `generated always as
 * identity` will not hand out before the insert — so it lands under a
 * placeholder and one same-transaction update settles the name. The
 * placeholder is the row's storage key: `attachments_storage_key_idx` already
 * guarantees it collides with nothing, and it never leaves this transaction.
 */
async function insertNamed(
  tx: Db,
  requested: string,
  values: Omit<typeof attachments.$inferInsert, "filename">,
): Promise<AttachmentRow> {
  const taken = await takenNames(tx, values.issueId);
  const free = !taken.has(nameKey(requested));
  const inserted = await tx
    .insert(attachments)
    .values({ ...values, filename: free ? requested : values.storageKey })
    .returning();
  const attachment = inserted[0];
  if (!attachment) throw new Error("attachment insert returned no row");
  if (free) return attachment;

  const renamed = await tx
    .update(attachments)
    .set({ filename: resolveCollision(taken, requested, attachment.id) })
    .where(eq(attachments.id, attachment.id))
    .returning();
  const settled = renamed[0];
  if (!settled) throw new Error("attachment rename returned no row");
  return settled;
}

/**
 * Reading the taken names and inserting are two statements, so a concurrent
 * upload of the same name on the same card can slip between them; the unique
 * index catches that and this retries the whole transaction, which reads the
 * winner's name on the way past. Both clients upload sequentially today, so
 * this is the index's escape hatch rather than a path anything walks.
 */
async function retryNaming<T>(attempt: () => Promise<T>): Promise<T> {
  for (let left = 5; ; left -= 1) {
    try {
      return await attempt();
    } catch (err) {
      if (uniqueViolation(err) !== "attachments_issue_filename_idx") throw err;
      if (left <= 1) {
        throw new ConflictError(
          "that filename is being written to this card concurrently; " +
            "retry the upload",
        );
      }
    }
  }
}

function publishAttachmentEvents(
  ctx: AppContext,
  projectId: number,
  attachmentId: number,
  issueId: number,
  issueNumber: number,
): void {
  for (const event of attachmentEvents(
    attachmentId,
    issueId,
    issueNumber,
    "created",
  )) {
    ctx.bus.publish(projectId, event);
  }
}

function attachmentEvents(
  attachmentId: number,
  issueId: number,
  issueNumber: number,
  action: "created" | "deleted",
): ChangeEvent[] {
  return [
    {
      entity: "attachment",
      id: attachmentId,
      action,
      issue_number: issueNumber,
    },
    // The `attachment_added` / `attachment_deleted` row; a timeline only
    // ever gains entries, whichever way the file went.
    {
      entity: "timeline",
      id: attachmentId,
      action: "created",
      issue_number: issueNumber,
    },
    // updated_at moved (T-101) → issue list ordering must refresh.
    {
      entity: "issue",
      id: issueId,
      action: "updated",
      issue_number: issueNumber,
      list_row: { kind: "activity" },
    },
  ];
}

const COMPLETE_GRACE_MS = 60 * 60 * 1000;

export async function requestDirectUpload(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: DirectUploadRequest,
): Promise<DirectUploadTicket> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "attachment.upload",
  );
  // The size gate precedes the backend gate: an oversize declaration means
  // no upload path will take the file, so clients probing this endpoint
  // first (the CLI does) learn that before shipping a single body byte —
  // a 409 here would instead send them into the multipart fallback.
  const maxBytes = ctx.config.storage.max_upload_mb * 1024 * 1024;
  if (input.size > maxBytes) {
    throw new ValidationFailedError(
      `file exceeds the ${ctx.config.storage.max_upload_mb} MB upload limit`,
    );
  }
  if (!(ctx.storage instanceof S3Storage)) {
    throw new DirectUploadUnavailableError();
  }
  const db = await ctx.router.forProject(routeInfoOf(project));

  const issueRows = await db
    .select({
      ...gateColumns,
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, project.id),
        eq(issues.number, input.issue_number),
      ),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");
  assertIssueWritable(issue, actor, role);

  const storageKey = newStorageKey();
  const expiresAt = new Date(
    Date.now() + ctx.config.storage.s3.upload_expiry_seconds * 1000,
  );
  const inserted = await db
    .insert(pendingUploads)
    .values({
      projectId: project.id,
      issueId: issue.id,
      uploaderId: actor.id,
      filename: sanitizeFilename(input.filename),
      contentType: input.content_type || "application/octet-stream",
      declaredSize: input.size,
      sha256: input.sha256 ?? null,
      storageKey,
      draft: input.draft === true,
      expiresAt,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("pending upload insert returned no row");

  const { url, headers } = await ctx.storage.presignPut(
    storageKey,
    input.size,
    input.sha256,
  );
  return {
    upload_id: row.id,
    url,
    headers,
    expires_at: expiresAt.toISOString(),
  };
}

export async function completeDirectUpload(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  uploadId: number,
  agentContext: AgentContext | null = null,
): Promise<Attachment> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "attachment.upload",
  );
  if (!(ctx.storage instanceof S3Storage)) {
    throw new DirectUploadUnavailableError();
  }
  const db = await ctx.router.forProject(routeInfoOf(project));

  const rows = await db
    .select()
    .from(pendingUploads)
    .where(
      and(
        eq(pendingUploads.id, uploadId),
        eq(pendingUploads.projectId, project.id),
      ),
    );
  const pending = rows[0];
  if (!pending) throw new NotFoundError("upload not found");
  if (pending.uploaderId !== actor.id) {
    throw new ForbiddenError("only the requesting uploader may complete");
  }

  const byKey = () =>
    db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.storageKey, pending.storageKey),
          eq(attachments.projectId, project.id),
        ),
      );

  if (pending.completedAt) {
    // Replay after a lost response: the attachment already exists.
    const existing = (await byKey())[0];
    if (!existing) throw new NotFoundError("attachment not found");
    return toAttachment(ctx, slug, existing);
  }
  // `gcPendingUploads` deletes the object of an uncompleted row once it is
  // a day past expiry, and a complete that headed the object just before
  // that would register an attachment with no bytes behind it (T-569). An
  // hour of grace keeps a PUT that finished as its URL expired completable
  // while staying a day clear of the reaper.
  if (pending.expiresAt.getTime() + COMPLETE_GRACE_MS < Date.now()) {
    throw new DirectUploadIncompleteError("expired");
  }

  const head = await ctx.storage.head(pending.storageKey);
  if (!head) throw new DirectUploadIncompleteError("missing");
  if (head.size !== pending.declaredSize) {
    throw new DirectUploadIncompleteError("size_mismatch");
  }

  const issueRows = await db
    .select({
      ...gateColumns,
    })
    .from(issues)
    .where(eq(issues.id, pending.issueId));
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");
  assertIssueWritable(issue, actor, role);

  let row: AttachmentRow;
  try {
    row = await retryNaming(() =>
      db.transaction(async (tx) => {
        const attachment = await insertNamed(tx, pending.filename, {
          projectId: project.id,
          issueId: pending.issueId,
          uploaderId: pending.uploaderId,
          contentType: pending.contentType,
          size: pending.declaredSize,
          storageKey: pending.storageKey,
          draft: pending.draft,
        });
        if (!pending.draft) {
          await announceInTx(tx, attachment, actor.id, agentContext);
        }
        await tx
          .update(pendingUploads)
          .set({ completedAt: new Date() })
          .where(eq(pendingUploads.id, pending.id));
        return attachment;
      }),
    );
  } catch (err) {
    // A concurrent complete of the same upload hit the storage_key unique
    // index first; converge on its row instead of surfacing the race.
    const existing = (await byKey())[0];
    if (!existing) throw err;
    return toAttachment(ctx, slug, existing);
  }

  if (!row.draft) {
    publishAttachmentEvents(
      ctx,
      project.id,
      row.id,
      pending.issueId,
      issue.number,
    );
  }
  return toAttachment(ctx, slug, row);
}

export async function openAttachment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  attachmentId: number,
  /** Which route asked, so a redirect can point at the same one. */
  via: { variant: "download" | "view"; filename: string | null } = {
    variant: "download",
    filename: null,
  },
): Promise<{ row: AttachmentRow }> {
  // Attachment URLs are pasted into bodies and followed long afterwards, so
  // reading one is decided by where the file is now (T-242) — otherwise a
  // reader of the destination alone sees a broken image.
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  // Joined to the issue rather than looked up by attachment id alone: the id
  // is the whole URL, so without the join a deleted card's attachments would
  // stay downloadable by anyone who ever saw one of those links (T-145).
  const rows = await db
    .select({
      row: attachments,
      ...gateColumns,
    })
    .from(attachments)
    .innerJoin(issues, eq(attachments.issueId, issues.id))
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.projectId, project.id),
      ),
    );
  const found = rows[0];
  if (!found) {
    // Not here may mean this project held it before the card moved (T-231);
    // only a miss pays for the system-database lookup.
    const alias = await aliasOf(
      ctx.router.system(),
      "attachment",
      project.id,
      attachmentId,
    );
    if (alias !== null) {
      throw new AttachmentMovedError(
        project.id,
        attachmentId,
        via.variant,
        via.filename,
        role !== null,
      );
    }
    throw new NotFoundError("attachment not found");
  }
  assertIssueReadable(found, actor, role);
  // The uploader's alone until a text links it: nobody else has been told
  // the id, and a sequential id is no secret.
  if (found.row.draft && found.row.uploaderId !== actor.id) {
    throw new NotFoundError("attachment not found");
  }
  return { row: found.row };
}

export async function listIssueAttachments(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<Attachment[]> {
  // The same rule as `openAttachment` above, one level up: the list belongs
  // to the card, so an old address answers to whoever can read where the card
  // is now (T-245). The three upload entries keep their own gate.
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issueRows = await db
    .select({
      ...gateColumns,
    })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");
  assertIssueReadable(issue, actor, role);
  // Ascending order is this endpoint's contract, not an accident of storage:
  // a name that collided is rewritten by an `update` right after its insert,
  // which used to hand those rows back last. `createdAt` leads because the
  // list renders that column — a row's position and its printed time have to
  // agree — and the id only settles ties within one clock tick.
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.issueId, issue.id), eq(attachments.draft, false)))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  const result: Attachment[] = [];
  for (const row of rows) {
    result.push(await toAttachment(ctx, slug, row));
  }
  await fillAliases(ctx, actor, project, result);
  return result;
}

/**
 * The other addresses each of these files still answers on (T-242), so a
 * body that named one before the card moved or the project was renamed can
 * still be resolved to the file it meant.
 */
async function fillAliases(
  ctx: AppContext,
  actor: UserRow,
  project: ProjectRow,
  list: Attachment[],
): Promise<void> {
  if (list.length === 0) return;
  const system = ctx.router.system();
  const ids = list.map((a) => a.id);
  const [moved, renames] = await Promise.all([
    aliasAddressesOf(system, "attachment", project.id, ids),
    formerSlugsOf(system, project),
  ]);
  // A project that never moved a card in and never changed its slug is the
  // norm, and it stops here — before the project rows and, above all, before
  // `visibleProjects`, which is the expensive one.
  if (moved.size === 0 && renames.length === 0) return;

  const slugsOf = await sourceSlugs(system, moved);
  const visible =
    moved.size === 0
      ? new Set<number>()
      : (await visibleProjects(ctx, actor)).ids;

  for (const attachment of list) {
    const found = new Map<string, AttachmentAlias>();
    const add = (slug: string, id: number) => {
      if (slug === project.slug && id === attachment.id) return;
      found.set(`${slug}/${id}`, { project: slug, id });
    };
    for (const slug of renames) add(slug, attachment.id);
    for (const from of moved.get(attachment.id) ?? []) {
      // Withheld on the same rule as `movesOf`: naming a project the reader
      // cannot read would tell them where this card came from.
      if (!visible.has(from.projectId)) continue;
      for (const slug of slugsOf.get(from.projectId) ?? []) add(slug, from.id);
    }
    attachment.aliases = [...found.values()].sort(
      (a, b) => a.project.localeCompare(b.project) || a.id - b.id,
    );
  }
}

/**
 * Every slug each source project answers on. The current one is not enough:
 * the source may have been renamed after the move, and what a body written
 * before that rename holds is the older spelling — which still resolves.
 */
async function sourceSlugs(
  system: Db,
  moved: Map<number, Array<{ projectId: number; id: number }>>,
): Promise<Map<number, string[]>> {
  const byProject = new Map<number, string[]>();
  const ids = [
    ...new Set(
      [...moved.values()].flatMap((list) => list.map((m) => m.projectId)),
    ),
  ];
  if (ids.length === 0) return byProject;
  const rows = await system
    .select()
    .from(projects)
    .where(inArray(projects.id, ids));
  for (const row of rows) {
    byProject.set(row.id, [row.slug, ...(await formerSlugsOf(system, row))]);
  }
  return byProject;
}

/** A file and the gate columns of the card it hangs on. */
async function loadForWrite(
  db: Db,
  projectId: number,
  attachmentId: number,
  actor: UserRow,
) {
  const rows = await db
    .select({ row: attachments, ...gateColumns })
    .from(attachments)
    .innerJoin(issues, eq(attachments.issueId, issues.id))
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.projectId, projectId),
      ),
    );
  const found = rows[0];
  // Someone else's draft is as absent here as it is from the list.
  if (!found || (found.row.draft && found.row.uploaderId !== actor.id)) {
    throw new NotFoundError("attachment not found");
  }
  return found;
}

/**
 * Delete one file (T-567): the row, an `attachment_deleted` event on its
 * card, and then the stored object.
 *
 * The object goes after the commit and outside it: deleting bytes cannot be
 * rolled back, so it waits until the row is certainly gone. If it fails the
 * object is unreachable — no row names it — and only the log says so.
 *
 * A draft leaves no event, the same way it arrived without one.
 */
export async function deleteAttachment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  attachmentId: number,
  agentContext: AgentContext | null = null,
): Promise<void> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "attachment.delete",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const found = await loadForWrite(db, project.id, attachmentId, actor);
  // A card being copied to another project shares its objects with the
  // copy, so this refuses it with the 409 every other write gets.
  assertIssueWritable(found, actor, role);
  const { row } = found;
  if (row.uploaderId !== actor.id && !can(role, "attachment.delete_any")) {
    throw new ForbiddenError(
      `only the uploader or a ${minRoleOf("attachment.delete_any")} may delete this file`,
    );
  }

  const deleted = await db.transaction(async (tx) => {
    const gone = await tx
      .delete(attachments)
      .where(eq(attachments.id, row.id))
      .returning({ id: attachments.id });
    if (gone.length === 0) return false;
    if (row.draft) return true;
    await tx.insert(issueEvents).values({
      projectId: project.id,
      issueId: row.issueId,
      actorId: actor.id,
      type: "attachment_deleted",
      agentContext,
      payload: {
        attachment: { id: row.id, filename: row.filename, size: row.size },
      },
    });
    await tx
      .update(issues)
      .set({ updatedAt: new Date() })
      .where(eq(issues.id, row.issueId));
    return true;
  });
  // Lost a race with another delete: that one already did everything below.
  if (!deleted) throw new NotFoundError("attachment not found");

  try {
    await ctx.storage.delete(row.storageKey);
  } catch (cause) {
    console.error(
      `attachment ${project.slug}#${row.id} deleted but its object ${row.storageKey} was not`,
      cause,
    );
  }
  if (row.draft) return;
  for (const event of attachmentEvents(
    row.id,
    row.issueId,
    found.number,
    "deleted",
  )) {
    ctx.bus.publish(project.id, event);
  }
}

/**
 * Every issue body and comment in this project that links the file, for the
 * delete confirmation to list (T-567). Cards in the trash are left out: their
 * text is not on anyone's screen, and listing it would show a reporter a
 * card they may not see.
 *
 * Links from other projects are not searched — a project's database holds
 * only its own text.
 */
export async function listAttachmentReferences(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  attachmentId: number,
): Promise<AttachmentReference[]> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "attachment.delete",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const found = await loadForWrite(db, project.id, attachmentId, actor);
  assertIssueReadable(found, actor, role);

  const owners = new Set([
    String(project.id),
    project.slug,
    ...(await formerSlugsOf(ctx.router.system(), project)),
  ]);
  // A cheap net for the precise parse below, which is what decides.
  const net = `%/attachments/${attachmentId}/%`;
  const live = and(
    eq(issues.projectId, project.id),
    isNull(issues.deletedAt),
    isNull(issues.movedAt),
  );
  const [bodies, commentRows] = await Promise.all([
    db
      .select({ number: issues.number, body: issues.body })
      .from(issues)
      .where(and(live, like(issues.body, net))),
    db
      .select({ number: issues.number, id: comments.id, body: comments.body })
      .from(comments)
      .innerJoin(issues, eq(comments.issueId, issues.id))
      .where(and(live, like(comments.body, net))),
  ]);
  const links = (text: string) =>
    linkedAttachmentIds(text, owners).has(attachmentId);

  const prefix = await currentRefPrefix(db, project.id);
  const result: AttachmentReference[] = [
    ...bodies
      .filter((b) => links(b.body))
      .map((b) => ({ number: b.number, comment: null })),
    ...commentRows
      .filter((c) => links(c.body))
      .map((c) => ({ number: c.number, comment: c.id })),
  ]
    .sort((a, b) => a.number - b.number || (a.comment ?? 0) - (b.comment ?? 0))
    .map((r) => ({
      issue_number: r.number,
      issue_ref: formatRef(prefix, r.number),
      comment_id: r.comment,
    }));
  return result;
}

/** The files deleted from one card, newest last, read off its events. */
export async function listDeletedAttachments(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<DeletedAttachment[]> {
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issueRows = await db
    .select({ ...gateColumns })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");
  assertIssueReadable(issue, actor, role);

  const rows = await db
    .select({
      actorId: issueEvents.actorId,
      payload: issueEvents.payload,
      createdAt: issueEvents.createdAt,
    })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.issueId, issue.id),
        eq(issueEvents.type, "attachment_deleted"),
      ),
    )
    .orderBy(asc(issueEvents.createdAt), asc(issueEvents.id));
  const refs = await getUserRefs(
    ctx.router.system(),
    rows.map((r) => r.actorId),
  );
  const result: DeletedAttachment[] = [];
  for (const row of rows) {
    const attachment = (row.payload as { attachment?: unknown }).attachment as
      | { id?: unknown; filename?: unknown }
      | undefined;
    const deletedBy = refs.get(row.actorId);
    if (
      typeof attachment?.id !== "number" ||
      typeof attachment.filename !== "string" ||
      deletedBy === undefined
    ) {
      continue;
    }
    result.push({
      id: attachment.id,
      filename: attachment.filename,
      deleted_by: deletedBy,
      deleted_at: row.createdAt.toISOString(),
    });
  }
  return result;
}

/**
 * Turn the drafts `texts` link into attachments (T-568), inside the
 * transaction that writes the text, so the file and the words that show it
 * reach the card together. Only the writer's own drafts: they are the only
 * ones the writer has been shown, and an id typed by hand must not be able
 * to publish somebody else's unsent file.
 *
 * Owners are this project's id and current slug only — what an editor
 * writes for a file it uploaded a moment ago. A draft lives a day at most,
 * so no former slug can be holding one.
 *
 * Returns the change events to publish after commit.
 */
export async function commitDraftAttachments(
  tx: Db,
  project: ProjectRow,
  actorId: number,
  texts: readonly string[],
  agentContext: AgentContext | null,
): Promise<ChangeEvent[]> {
  const owners = new Set([String(project.id), project.slug]);
  const ids = new Set<number>();
  for (const text of texts) {
    for (const id of linkedAttachmentIds(text, owners)) ids.add(id);
  }
  if (ids.size === 0) return [];
  const committed = await tx
    .update(attachments)
    .set({ draft: false })
    .where(
      and(
        eq(attachments.projectId, project.id),
        eq(attachments.uploaderId, actorId),
        eq(attachments.draft, true),
        inArray(attachments.id, [...ids]),
      ),
    )
    .returning();
  const events: ChangeEvent[] = [];
  for (const row of committed) {
    await announceInTx(tx, row, actorId, agentContext);
    const [card] = await tx
      .select({ number: issues.number })
      .from(issues)
      .where(eq(issues.id, row.issueId));
    if (!card) continue;
    events.push(
      ...attachmentEvents(row.id, row.issueId, card.number, "created"),
    );
  }
  return events;
}
