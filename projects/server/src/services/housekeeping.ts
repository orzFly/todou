import { and, isNotNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { sessions, tokens } from "../db/system-schema.ts";

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
