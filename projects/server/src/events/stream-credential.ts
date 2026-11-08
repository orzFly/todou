import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../auth/middleware.ts";
import { hashToken, type UserRow } from "../auth/pat.ts";
import { SESSION_COOKIE } from "../auth/session.ts";
import type { Db } from "../db/driver.ts";
import { sessions, tokens, users } from "../db/system-schema.ts";

/**
 * What a long-lived stream authenticated with, kept so the stream can ask
 * again later (T-624). The middleware answers once per request, and an SSE
 * request lasts until the socket dies — a revoked token, a logout or a
 * disabled account would otherwise go on receiving events indefinitely.
 *
 * `identity` is forward mode: the proxy re-asserts the user on every request
 * and there is no secret of ours to re-check, so only the account itself can
 * be.
 */
export type StreamCredential =
  | { kind: "pat"; hash: string }
  | { kind: "session"; hash: string }
  | { kind: "identity" };

/**
 * The credential the auth middleware accepted for this request, picked by
 * the same precedence it uses. Only called after the middleware succeeded,
 * so the branch taken is the one that authenticated.
 */
export function streamCredentialOf(c: Context<AppEnv>): StreamCredential {
  const header = c.req.header("authorization");
  if (header !== undefined) {
    const token = header.split(" ").slice(1).join(" ").trim();
    return { kind: "pat", hash: hashToken(token) };
  }
  if (c.get("appCtx").config.auth.mode === "forward") {
    return { kind: "identity" };
  }
  return {
    kind: "session",
    hash: hashToken(getCookie(c, SESSION_COOKIE) ?? ""),
  };
}

/**
 * The account behind the credential if it would still authenticate a request
 * now, else null. Read-only on purpose: `verifyPat` bumps `last_used_at` and
 * `validateSession` slides the expiry, and an idle open stream doing either
 * every heartbeat would keep a session alive forever and make an unused
 * token look used.
 */
export async function recheckStreamCredential(
  db: Db,
  credential: StreamCredential,
  userId: number,
): Promise<UserRow | null> {
  const now = Date.now();
  let user: UserRow | undefined;
  if (credential.kind === "pat") {
    const rows = await db
      .select({ token: tokens, user: users })
      .from(tokens)
      .innerJoin(users, eq(tokens.userId, users.id))
      .where(
        and(eq(tokens.tokenHash, credential.hash), isNull(tokens.revokedAt)),
      );
    const row = rows[0];
    if (row?.token.expiresAt && row.token.expiresAt.getTime() <= now) {
      return null;
    }
    user = row?.user;
  } else if (credential.kind === "session") {
    const rows = await db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, credential.hash));
    const row = rows[0];
    if (row && row.session.expiresAt.getTime() <= now) return null;
    user = row?.user;
  } else {
    user = (await db.select().from(users).where(eq(users.id, userId)))[0];
  }
  if (user === undefined || user.id !== userId || user.disabledAt) return null;
  return user;
}
