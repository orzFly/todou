import { randomUUID } from "node:crypto";
import type {
  AgentContext,
  Attachment,
  AttachmentAlias,
  DirectUploadRequest,
  DirectUploadTicket,
} from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  attachments,
  issueEvents,
  issues,
  pendingUploads,
} from "../db/project-schema.ts";
import { projects } from "../db/system-schema.ts";
import {
  AttachmentMovedError,
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
  requireProject,
  routeInfoOf,
} from "./access.ts";
import { visibleProjects } from "./cross-references.ts";
import { formerSlugsOf } from "./projects.ts";
import { aliasAddressesOf, aliasOf } from "./relocation.ts";
import {
  assertIssueReadable,
  assertIssueWritable,
  gateColumns,
} from "./trash.ts";
import { getUserRefs } from "./users.ts";

type AttachmentRow = typeof attachments.$inferSelect;

export function sanitizeFilename(name: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replaceAll(/[\u0000-\u001f/\\:"'<>|?*]/g, "_")
    .replaceAll("..", "_")
    .trim();
  return cleaned === "" ? "attachment" : cleaned.slice(0, 200);
}

/**
 * encodeURIComponent leaves ( ) ' ! * alone; parentheses would terminate
 * a markdown `](…)` destination early, and these URLs get pasted into
 * markdown bodies verbatim.
 */
function encodeNameSegment(name: string): string {
  return encodeURIComponent(name).replaceAll("(", "%28").replaceAll(")", "%29");
}

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
): Promise<Attachment> {
  const { project, role } = await requireProject(ctx, actor, slug, "writer");
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

  const filename = sanitizeFilename(file.name);
  const row = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(attachments)
      .values({
        projectId: project.id,
        issueId: issue.id,
        uploaderId: actor.id,
        filename,
        contentType: file.type || "application/octet-stream",
        size: file.size,
        storageKey,
      })
      .returning();
    const attachment = inserted[0];
    if (!attachment) throw new Error("attachment insert returned no row");

    await tx.insert(issueEvents).values({
      projectId: project.id,
      issueId: issue.id,
      actorId: actor.id,
      type: "attachment_added",
      agentContext,
      payload: {
        attachment: { id: attachment.id, filename, size: file.size },
      },
    });
    await tx
      .update(issues)
      .set({ updatedAt: new Date() })
      .where(eq(issues.id, issue.id));
    return attachment;
  });

  publishAttachmentEvents(ctx, project.id, row.id, issue.id, issueNumber);
  return toAttachment(ctx, slug, row);
}

function newStorageKey(): string {
  const uuid = randomUUID();
  return `${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
}

function publishAttachmentEvents(
  ctx: AppContext,
  projectId: number,
  attachmentId: number,
  issueId: number,
  issueNumber: number,
): void {
  ctx.bus.publish(projectId, {
    entity: "attachment",
    id: attachmentId,
    action: "created",
    issue_number: issueNumber,
  });
  ctx.bus.publish(projectId, {
    entity: "timeline",
    id: attachmentId,
    action: "created",
    issue_number: issueNumber,
  });
  // updated_at moved (T-101) → issue list ordering must refresh.
  ctx.bus.publish(projectId, {
    entity: "issue",
    id: issueId,
    action: "updated",
    issue_number: issueNumber,
  });
}

export async function requestDirectUpload(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: DirectUploadRequest,
): Promise<DirectUploadTicket> {
  const { project, role } = await requireProject(ctx, actor, slug, "writer");
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
  const { project, role } = await requireProject(ctx, actor, slug, "writer");
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
    row = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(attachments)
        .values({
          projectId: project.id,
          issueId: pending.issueId,
          uploaderId: pending.uploaderId,
          filename: pending.filename,
          contentType: pending.contentType,
          size: pending.declaredSize,
          storageKey: pending.storageKey,
        })
        .returning();
      const attachment = inserted[0];
      if (!attachment) throw new Error("attachment insert returned no row");

      await tx.insert(issueEvents).values({
        projectId: project.id,
        issueId: pending.issueId,
        actorId: actor.id,
        type: "attachment_added",
        agentContext,
        payload: {
          attachment: {
            id: attachment.id,
            filename: pending.filename,
            size: pending.declaredSize,
          },
        },
      });
      await tx
        .update(pendingUploads)
        .set({ completedAt: new Date() })
        .where(eq(pendingUploads.id, pending.id));
      await tx
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, pending.issueId));
      return attachment;
    });
  } catch (err) {
    // A concurrent complete of the same upload hit the storage_key unique
    // index first; converge on its row instead of surfacing the race.
    const existing = (await byKey())[0];
    if (!existing) throw err;
    return toAttachment(ctx, slug, existing);
  }

  publishAttachmentEvents(
    ctx,
    project.id,
    row.id,
    pending.issueId,
    issue.number,
  );
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
  return { row: found.row };
}

export async function listIssueAttachments(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<Attachment[]> {
  const { project, role } = await requireProject(ctx, actor, slug, "reader");
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
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.issueId, issue.id));
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
