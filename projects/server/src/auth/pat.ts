import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { tokens, users } from "../db/system-schema.ts";

export const PAT_PREFIX = "todou_pat_";
/** Shown in token lists so users can tell tokens apart. */
const DISPLAY_PREFIX_LENGTH = 16;
/** last_used_at is refreshed at most once per this window. */
const LAST_USED_THROTTLE_MS = 60_000;

export function hashToken(token: string): string {
  // PATs are 32 bytes of entropy, so a fast hash is enough — this is not a
  // password. Never store or log the plaintext.
  return createHash("sha256").update(token).digest("hex");
}

export function generatePat(): { token: string; hash: string; prefix: string } {
  const token = PAT_PREFIX + randomBytes(32).toString("base64url");
  return {
    token,
    hash: hashToken(token),
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

export type UserRow = typeof users.$inferSelect;

/**
 * Resolve a bearer token to its user. Returns null for unknown, revoked, or
 * expired tokens — callers must reject with 401 and never fall back to
 * another identity.
 */
export async function verifyPat(
  db: Db,
  token: string,
): Promise<UserRow | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const now = new Date();
  const rows = await db
    .select({ token: tokens, user: users })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .where(
      and(eq(tokens.tokenHash, hashToken(token)), isNull(tokens.revokedAt)),
    );
  const row = rows[0];
  if (!row) return null;
  if (row.token.expiresAt && row.token.expiresAt <= now) return null;

  const lastUsed = row.token.lastUsedAt?.getTime() ?? 0;
  if (now.getTime() - lastUsed > LAST_USED_THROTTLE_MS) {
    await db
      .update(tokens)
      .set({ lastUsedAt: now })
      .where(eq(tokens.id, row.token.id));
  }
  return row.user;
}
