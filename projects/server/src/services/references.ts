import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { refFormats } from "../db/project-schema.ts";

/**
 * The internal reference prefix in force at `at`: the newest ref_formats
 * row with effective_from <= at, null (= "#") before the first row.
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
