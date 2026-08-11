import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { sessions, users } from "../db/system-schema.ts";
import type { UserRow } from "./pat.ts";
import { hashToken } from "./pat.ts";

export const SESSION_COOKIE = "todou_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding renewal: extend when less than half the TTL remains. */
const RENEW_BELOW_MS = SESSION_TTL_MS / 2;

export async function createSession(
  db: Db,
  userId: number,
): Promise<{ value: string; expiresAt: Date }> {
  const value = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db
    .insert(sessions)
    .values({ tokenHash: hashToken(value), userId, expiresAt });
  return { value, expiresAt };
}

export async function validateSession(
  db: Db,
  value: string,
): Promise<UserRow | null> {
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, hashToken(value)));
  const row = rows[0];
  if (!row) return null;
  if (row.user.disabledAt) return null;
  const now = Date.now();
  if (row.session.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return null;
  }
  if (row.session.expiresAt.getTime() - now < RENEW_BELOW_MS) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(sessions.id, row.session.id));
  }
  return row.user;
}

export async function destroySession(db: Db, value: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(value)));
}
