import { MePrefs, type MePrefsPatch } from "@todou/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { userPrefs } from "../db/system-schema.ts";

/**
 * Stored blobs may carry keys this build doesn't know, or values it cannot
 * read — a newer server wrote an enum member that was then rolled back
 * (T-157). Both are dropped so the schema default fills the gap and a read
 * never throws on an old row; a strict parse here would 500 the whole GET
 * over one display preference.
 */
function toPrefs(stored: unknown): MePrefs {
  const source =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const known: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(MePrefs.shape)) {
    if (key in source && schema.safeParse(source[key]).success) {
      known[key] = source[key];
    }
  }
  return MePrefs.parse(known);
}

/** The caller's preferences; no row means every key at its default. */
export async function readPrefs(db: Db, userId: number): Promise<MePrefs> {
  const rows = await db
    .select({ prefs: userPrefs.prefs })
    .from(userPrefs)
    .where(eq(userPrefs.userId, userId));
  return toPrefs(rows[0]?.prefs);
}

/**
 * Shallow-merge a patch into the caller's preferences. The merge runs in
 * SQL (jsonb ||) so concurrent patches to different keys both survive —
 * no read-modify-write window.
 */
export async function updatePrefs(
  db: Db,
  userId: number,
  patch: MePrefsPatch,
): Promise<MePrefs> {
  const merged = await db
    .insert(userPrefs)
    .values({ userId, prefs: patch })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: {
        prefs: sql`${userPrefs.prefs} || excluded.prefs`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ prefs: userPrefs.prefs });
  const row = merged[0];
  if (!row) throw new Error("prefs upsert returned no row");
  return toPrefs(row.prefs);
}
