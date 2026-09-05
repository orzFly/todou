/**
 * The 0013 rename (T-269) exercised against a real project schema.
 *
 * The index it ends with is already in place by the time any test app is up,
 * so the fixture drops it first — that is the only way rows the migration was
 * written for can exist at all. Shared by the PGlite and the real-postgres
 * suite because these three statements are SQL, not TypeScript: passing on
 * one driver says nothing about the other.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { uniqueViolation } from "../src/auth/provision.ts";
import type { Db } from "../src/db/driver.ts";
import { attachments } from "../src/db/project-schema.ts";

const MIGRATION = new URL(
  "../drizzle/project/0013_attachment_filename_unique.sql",
  import.meta.url,
);

async function statements(): Promise<string[]> {
  const text = await readFile(MIGRATION, "utf8");
  return text
    .split("--> statement-breakpoint")
    .map((one) => one.trim())
    .filter((one) => one !== "");
}

/** The two renaming statements; the index is the third and runs on its own. */
async function rename(db: Db): Promise<void> {
  for (const statement of (await statements()).slice(0, 2)) {
    await db.execute(sql.raw(statement));
  }
}

async function createIndex(db: Db): Promise<void> {
  const [, , index] = await statements();
  await db.execute(sql.raw(index as string));
}

export type SeedIds = {
  projectId: number;
  issueId: number;
  uploaderId: number;
};

async function seed(db: Db, ids: SeedIds, names: string[]): Promise<number[]> {
  const inserted = await db
    .insert(attachments)
    .values(
      names.map((filename) => ({
        projectId: ids.projectId,
        issueId: ids.issueId,
        uploaderId: ids.uploaderId,
        filename,
        contentType: "application/octet-stream",
        size: 1,
        storageKey: randomUUID(),
      })),
    )
    .returning({ id: attachments.id });
  return inserted.map((row) => row.id);
}

async function namesById(
  db: Db,
  issueId: number,
): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: attachments.id, filename: attachments.filename })
    .from(attachments)
    .where(eq(attachments.issueId, issueId))
    .orderBy(attachments.id);
  return new Map(rows.map((row) => [row.id, row.filename]));
}

/**
 * Seed the collision shapes measured on the real corpus, run the migration,
 * and check what it left behind — including that a second run changes
 * nothing, which is what makes a real run after a `--dry-run` safe.
 */
export async function checkFilenameMigration(
  db: Db,
  ids: SeedIds,
): Promise<void> {
  // One transaction, always rolled back. DDL is transactional in postgres, so
  // the index this has to drop is never observably missing to anyone else on
  // a shared test database — they block on the lock instead — and nothing the
  // fixture seeds survives the run.
  const ROLLBACK = Symbol("rollback");
  try {
    await db.transaction(async (tx) => {
      await scenario(tx, ids);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

async function scenario(db: Db, ids: SeedIds): Promise<void> {
  await db.execute(sql.raw('DROP INDEX "attachments_issue_filename_idx"'));

  const [a1, a2, a3, img, r1, r2] = (await seed(db, ids, [
    "a.png",
    "a.png",
    "A.PNG",
    "image.png",
    "README",
    "README",
  ])) as [number, number, number, number, number, number];

  await rename(db);
  const after = await namesById(db, ids.issueId);

  // The first row of each clashing group keeps the name readers already know.
  expect(after.get(a1)).toBe("a.png");
  expect(after.get(r1)).toBe("README");
  expect(after.get(a2)).toBe(`a-${a2}.png`);
  // Folded case clashes too, but the surviving spelling is the original one.
  expect(after.get(a3)).toBe(`A-${a3}.PNG`);
  // No extension: the suffix lands at the end rather than inside the name.
  expect(after.get(r2)).toBe(`README-${r2}`);
  expect(after.get(img)).toMatch(/^image-\d{8}-\d{6}-\d+\.png$/);
  expect(after.get(img)).toContain(`-${img}.png`);

  const folded = [...after.values()].map((name) => name.toLowerCase());
  expect(new Set(folded).size).toBe(folded.length);

  await rename(db);
  expect(await namesById(db, ids.issueId)).toEqual(after);

  await createIndex(db);
  // Named, not merely thrown: the upload path retries on exactly this
  // constraint name, and node-postgres and PGlite report it differently.
  // On a savepoint, so the violation does not abort the run's transaction.
  const clash = await db
    .transaction((sp) => seed(sp, ids, ["A.png"]))
    .then(
      () => null,
      (err: unknown) => uniqueViolation(err),
    );
  expect(clash).toBe("attachments_issue_filename_idx");
}
