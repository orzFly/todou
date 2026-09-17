import { randomUUID } from "node:crypto";
import { AVATAR_MAX_BYTES, isAvatarContentType } from "@todou/shared";
import { eq } from "drizzle-orm";
import type { AppContext } from "../bootstrap.ts";
import { projects } from "../db/system-schema.ts";
import {
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from "../errors.ts";

type ProjectRow = typeof projects.$inferSelect;

/**
 * Replace a project's icon.
 *
 * The limits are the avatar's, deliberately: an icon and an avatar are the
 * same kind of thing — small, square, decorative — and two constants for it
 * would only give them room to drift apart.
 */
export async function setProjectIcon(
  ctx: AppContext,
  target: ProjectRow,
  file: File,
): Promise<ProjectRow> {
  if (!isAvatarContentType(file.type)) {
    throw new UnsupportedMediaTypeError(
      "icon must be a png, jpeg, webp, or gif image",
    );
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new PayloadTooLargeError(
      `icon exceeds the ${AVATAR_MAX_BYTES / 1024 / 1024} MB limit`,
    );
  }

  const uuid = randomUUID();
  const key = `project-icons/${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
  await ctx.storage.put(key, new Uint8Array(await file.arrayBuffer()));

  const updated = await ctx.router
    .system()
    .update(projects)
    .set({ iconKey: key, iconContentType: file.type })
    .where(eq(projects.id, target.id))
    .returning();
  const row = updated[0];
  if (!row) throw new Error("project icon update returned no row");

  // Only once the row points at the new blob: the other order can leave the
  // row naming a key that is already gone.
  if (target.iconKey) await ctx.storage.delete(target.iconKey);
  return row;
}

export async function deleteProjectIcon(
  ctx: AppContext,
  target: ProjectRow,
): Promise<ProjectRow> {
  const updated = await ctx.router
    .system()
    .update(projects)
    .set({ iconKey: null, iconContentType: null })
    .where(eq(projects.id, target.id))
    .returning();
  const row = updated[0];
  if (!row) throw new Error("project icon update returned no row");

  if (target.iconKey) await ctx.storage.delete(target.iconKey);
  return row;
}

/** Locate a project's icon blob for serving; 404 when absent. */
export async function openProjectIcon(
  ctx: AppContext,
  projectId: number,
): Promise<{ key: string; contentType: string }> {
  const rows = await ctx.router
    .system()
    .select({ key: projects.iconKey, contentType: projects.iconContentType })
    .from(projects)
    .where(eq(projects.id, projectId));
  const row = rows[0];
  if (!row?.key) throw new NotFoundError("project icon not found");
  return {
    key: row.key,
    contentType: row.contentType ?? "application/octet-stream",
  };
}
