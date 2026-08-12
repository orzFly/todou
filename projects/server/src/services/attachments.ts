import { randomUUID } from "node:crypto";
import type {
  AgentContext,
  Attachment,
  DirectUploadRequest,
  DirectUploadTicket,
} from "@todou/shared";
import { and, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  attachments,
  issueEvents,
  issues,
  pendingUploads,
} from "../db/project-schema.ts";
import {
  DirectUploadIncompleteError,
  DirectUploadUnavailableError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { S3Storage } from "../storage/s3.ts";
import { requireProject, routeInfoOf } from "./access.ts";
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
  const { project } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const maxBytes = ctx.config.storage.max_upload_mb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new ValidationFailedError(
      `file exceeds the ${ctx.config.storage.max_upload_mb} MB upload limit`,
    );
  }

  const issueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");

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
    return attachment;
  });

  publishAttachmentEvents(ctx, project.id, row.id, issueNumber);
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
}

export async function requestDirectUpload(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: DirectUploadRequest,
): Promise<DirectUploadTicket> {
  const { project } = await requireProject(ctx, actor, slug, "writer");
  if (!(ctx.storage instanceof S3Storage)) {
    throw new DirectUploadUnavailableError();
  }
  const db = await ctx.router.forProject(routeInfoOf(project));

  const maxBytes = ctx.config.storage.max_upload_mb * 1024 * 1024;
  if (input.size > maxBytes) {
    throw new ValidationFailedError(
      `file exceeds the ${ctx.config.storage.max_upload_mb} MB upload limit`,
    );
  }
  const issueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, project.id),
        eq(issues.number, input.issue_number),
      ),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");

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
  const { project } = await requireProject(ctx, actor, slug, "writer");
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
    .select({ number: issues.number })
    .from(issues)
    .where(eq(issues.id, pending.issueId));
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");

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
      return attachment;
    });
  } catch (err) {
    // A concurrent complete of the same upload hit the storage_key unique
    // index first; converge on its row instead of surfacing the race.
    const existing = (await byKey())[0];
    if (!existing) throw err;
    return toAttachment(ctx, slug, existing);
  }

  publishAttachmentEvents(ctx, project.id, row.id, issue.number);
  return toAttachment(ctx, slug, row);
}

export async function openAttachment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  attachmentId: number,
): Promise<{ row: AttachmentRow }> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.projectId, project.id),
      ),
    );
  const row = rows[0];
  if (!row) throw new NotFoundError("attachment not found");
  return { row };
}

export async function listIssueAttachments(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<Attachment[]> {
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
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.issueId, issue.id));
  const result: Attachment[] = [];
  for (const row of rows) {
    result.push(await toAttachment(ctx, slug, row));
  }
  return result;
}
