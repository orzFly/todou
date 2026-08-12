import { randomUUID } from "node:crypto";
import type { AgentContext, Attachment } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { attachments, issueEvents, issues } from "../db/project-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
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

  const uuid = randomUUID();
  const storageKey = `${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
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

  ctx.bus.publish(project.id, {
    entity: "attachment",
    id: row.id,
    action: "created",
    issue_number: issueNumber,
  });
  ctx.bus.publish(project.id, {
    entity: "timeline",
    id: row.id,
    action: "created",
    issue_number: issueNumber,
  });
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
