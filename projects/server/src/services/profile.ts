import { randomUUID } from "node:crypto";
import { AVATAR_MAX_BYTES, isAvatarContentType } from "@todou/shared";
import { eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { users } from "../db/system-schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";

export type ProfilePatch = { display_name?: string; login?: string };

/**
 * Apply a display name / login change to `target`. Caller is responsible
 * for authorization (self via /me, owner via /agents). The login uniqueness
 * pre-check is racy; users_login_idx is the real guarantee, so the unique
 * violation is translated to the same 409.
 */
export async function updateProfile(
  ctx: AppContext,
  target: UserRow,
  patch: ProfilePatch,
): Promise<UserRow> {
  const db = ctx.router.system();
  if (patch.login !== undefined && patch.login !== target.login) {
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.login, patch.login));
    if (clash.length > 0 && clash[0]?.id !== target.id) {
      throw new ConflictError(`login "${patch.login}" is already taken`);
    }
  }
  let updated: UserRow[];
  try {
    updated = await db
      .update(users)
      .set({
        ...(patch.display_name === undefined
          ? {}
          : { displayName: patch.display_name }),
        ...(patch.login === undefined ? {} : { login: patch.login }),
      })
      .where(eq(users.id, target.id))
      .returning();
  } catch (err) {
    if (isLoginUniqueViolation(err)) {
      throw new ConflictError(`login "${patch.login}" is already taken`);
    }
    throw err;
  }
  const row = updated[0];
  if (!row) throw new Error("profile update returned no row");
  return row;
}

function isLoginUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = err; e && typeof e === "object" && !seen.has(e); ) {
    seen.add(e);
    const { code, message, cause } = e as {
      code?: string;
      message?: string;
      cause?: unknown;
    };
    if (code === "23505" || message?.includes("users_login_idx")) return true;
    e = cause;
  }
  return false;
}

export async function setAvatar(
  ctx: AppContext,
  target: UserRow,
  file: File,
): Promise<UserRow> {
  if (!isAvatarContentType(file.type)) {
    throw new ValidationFailedError(
      "avatar must be a png, jpeg, webp, or gif image",
    );
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new ValidationFailedError(
      `avatar exceeds the ${AVATAR_MAX_BYTES / 1024 / 1024} MB limit`,
    );
  }

  const uuid = randomUUID();
  const key = `avatars/${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
  await ctx.storage.put(key, new Uint8Array(await file.arrayBuffer()));

  const updated = await ctx.router
    .system()
    .update(users)
    .set({ avatarKey: key, avatarContentType: file.type })
    .where(eq(users.id, target.id))
    .returning();
  const row = updated[0];
  if (!row) throw new Error("avatar update returned no row");

  if (target.avatarKey) await ctx.storage.delete(target.avatarKey);
  return row;
}

export async function deleteAvatar(
  ctx: AppContext,
  target: UserRow,
): Promise<UserRow> {
  const updated = await ctx.router
    .system()
    .update(users)
    .set({ avatarKey: null, avatarContentType: null })
    .where(eq(users.id, target.id))
    .returning();
  const row = updated[0];
  if (!row) throw new Error("avatar update returned no row");

  if (target.avatarKey) await ctx.storage.delete(target.avatarKey);
  return row;
}

/** Locate a user's avatar blob for serving; 404 when absent. */
export async function openAvatar(
  ctx: AppContext,
  userId: number,
): Promise<{ key: string; contentType: string }> {
  const rows = await ctx.router
    .system()
    .select({ key: users.avatarKey, contentType: users.avatarContentType })
    .from(users)
    .where(eq(users.id, userId));
  const row = rows[0];
  if (!row?.key) throw new NotFoundError("avatar not found");
  return {
    key: row.key,
    contentType: row.contentType ?? "application/octet-stream",
  };
}
