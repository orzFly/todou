import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { refFormats } from "../db/project-schema.ts";

/**
 * The internal reference prefix in force right now: the newest ref_formats
 * row, null (= "#") when there is none.
 *
 * No time comparison, because there is no clock to compare against — the
 * rows are stamped by the project database and the question is asked by the
 * application, so a row stamped δ ahead of the application would otherwise
 * go unnoticed for δ after the switch (T-360).
 *
 * That holds only while no writer stamps a future effective_from, which is
 * what both of them do today: creating a project copies its created_at
 * (`projects.ts`), and switching the format takes the database's own now
 * (`reference-config.ts`). Scheduling a switch for a later instant would
 * break it, and this would have to go back to comparing.
 */
export async function currentRefPrefix(
  db: Db,
  projectId: number,
): Promise<string | null> {
  const rows = await db
    .select({ prefix: refFormats.prefix })
    .from(refFormats)
    .where(eq(refFormats.projectId, projectId))
    .orderBy(desc(refFormats.effectiveFrom), desc(refFormats.id))
    .limit(1);
  return rows[0]?.prefix ?? null;
}

/**
 * The internal reference prefix in force at `at`: the newest ref_formats
 * row with effective_from <= at, null (= "#") before the first row.
 *
 * Only for text whose writing instant is itself on record — the backfill in
 * `refs-migrate`. Everything asking about the present wants
 * `currentRefPrefix`.
 */
export async function refPrefixAt(
  db: Db,
  projectId: number,
  at: Date,
): Promise<string | null> {
  const rows = await db
    .select({ prefix: refFormats.prefix })
    .from(refFormats)
    .where(
      and(
        eq(refFormats.projectId, projectId),
        lte(refFormats.effectiveFrom, at),
      ),
    )
    .orderBy(desc(refFormats.effectiveFrom), desc(refFormats.id))
    .limit(1);
  return rows[0]?.prefix ?? null;
}
