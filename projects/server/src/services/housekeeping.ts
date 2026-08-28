import { and, isNotNull, lte, or } from "drizzle-orm";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { sessions, tokens } from "../db/system-schema.ts";
import { syncRefPrefixMirror } from "./reference-directory.ts";

/** Hourly is plenty: dead rows are inert (auth re-checks expiry/revocation
 * on every request) — the sweep only reclaims storage. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type SweepResult = { sessions: number; tokens: number };

/**
 * Delete auth rows that can no longer authenticate anyone: expired sessions,
 * and tokens that are revoked or past their expiry. Plain conditional
 * DELETEs — idempotent and safe to run concurrently from several instances.
 */
export async function sweepAuthRows(
  db: Db,
  now: Date = new Date(),
): Promise<SweepResult> {
  const deadSessions = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  const deadTokens = await db
    .delete(tokens)
    .where(
      or(
        isNotNull(tokens.revokedAt),
        and(isNotNull(tokens.expiresAt), lte(tokens.expiresAt, now)),
      ),
    )
    .returning({ id: tokens.id });
  return { sessions: deadSessions.length, tokens: deadTokens.length };
}

/**
 * One-shot boot chores. The prefix mirror is rebuilt rather than trusted:
 * it lives in a different database from the histories it copies, so a
 * crash between the two writes is repaired here and nowhere else.
 * Failure is logged, never fatal — a stale mirror only costs bare-prefix
 * resolution, and the server is still useful without it.
 */
export async function runStartupChores(ctx: AppContext): Promise<void> {
  try {
    const added = await syncRefPrefixMirror(ctx);
    if (added > 0) {
      console.log(`housekeeping: mirrored ${added} reference-format row(s)`);
    }
  } catch (err) {
    console.error("housekeeping: reference-prefix mirror sync failed", err);
  }
}

/**
 * Run the auth sweep now and then on an interval. Returns a stop function —
 * the serve shutdown path must call it (see T-56's graceful-shutdown hook).
 * The timer is unref'd so a missed stop can never hold the process open.
 */
export function startHousekeeping(
  db: Db,
  intervalMs: number = SWEEP_INTERVAL_MS,
): () => void {
  const run = async () => {
    try {
      const swept = await sweepAuthRows(db);
      if (swept.sessions > 0 || swept.tokens > 0) {
        console.log(
          `housekeeping: purged ${swept.sessions} session(s), ${swept.tokens} token(s)`,
        );
      }
    } catch (err) {
      // Sweep failures must never take the server down; the next tick retries.
      console.error("housekeeping sweep failed", err);
    }
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
