import { eq, isNotNull, lt } from "drizzle-orm";
import { attachments, pendingUploads } from "../db/project-schema.ts";
import type { DbRouter } from "../db/router.ts";
import { projects, users } from "../db/system-schema.ts";
import type { StorageBackend } from "../storage/types.ts";

export type BlobKey = { key: string; origin: string };

/**
 * Every blob key the deployment knows about: avatars from the system
 * database plus attachments from every project database. This enumeration
 * — not a bucket listing — is the source of truth for migration, so the
 * tool scales with the database, never with bucket size.
 */
export async function enumerateBlobKeys(router: DbRouter): Promise<BlobKey[]> {
  const keys: BlobKey[] = [];
  const avatarRows = await router
    .system()
    .select({ key: users.avatarKey, login: users.login })
    .from(users)
    .where(isNotNull(users.avatarKey));
  for (const row of avatarRows) {
    if (row.key) keys.push({ key: row.key, origin: `avatar:${row.login}` });
  }

  const projectRows = await router
    .system()
    .select({
      id: projects.id,
      slug: projects.slug,
      databaseUrl: projects.databaseUrl,
    })
    .from(projects);
  for (const project of projectRows) {
    const db = await router.forProject({
      id: project.id,
      slug: project.slug,
      database_url: project.databaseUrl,
    });
    const rows = await db
      .select({ key: attachments.storageKey, id: attachments.id })
      .from(attachments);
    for (const row of rows) {
      keys.push({ key: row.key, origin: `${project.slug}#att${row.id}` });
    }
  }
  return keys;
}

export type CopyReport = { copied: number; skipped: number; failed: number };

export async function copyMissing(
  src: StorageBackend,
  dst: StorageBackend,
  keys: BlobKey[],
  opts: { dryRun: boolean; log: (line: string) => void },
): Promise<CopyReport> {
  const report: CopyReport = { copied: 0, skipped: 0, failed: 0 };
  for (const { key, origin } of keys) {
    try {
      const srcHead = await src.head(key);
      if (!srcHead) {
        report.failed++;
        opts.log(`FAIL ${key} (${origin}): missing at source`);
        continue;
      }
      const dstHead = await dst.head(key);
      if (dstHead && dstHead.size === srcHead.size) {
        report.skipped++;
        continue;
      }
      if (opts.dryRun) {
        report.copied++;
        opts.log(`would copy ${key} (${origin}, ${srcHead.size} bytes)`);
        continue;
      }
      const { stream } = await src.getStream(key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      await dst.put(key, new Uint8Array(Buffer.concat(chunks)));
      report.copied++;
      opts.log(`copied ${key} (${origin}, ${srcHead.size} bytes)`);
    } catch (cause) {
      report.failed++;
      opts.log(`FAIL ${key} (${origin}): ${String(cause)}`);
    }
  }
  return report;
}

export type GcReport = {
  deletedObjects: number;
  droppedRows: number;
  wouldDelete: number;
};

/**
 * Walks pending_uploads rows past their expiry (plus a safety margin so a
 * slow-but-legitimate upload is never reaped mid-flight): uncompleted rows
 * are orphan candidates whose objects get deleted; completed rows just get
 * dropped — their object is a registered attachment now.
 */
export async function gcPendingUploads(
  router: DbRouter,
  storage: StorageBackend,
  opts: { dryRun: boolean; minAgeHours: number; log: (line: string) => void },
): Promise<GcReport> {
  const report: GcReport = {
    deletedObjects: 0,
    droppedRows: 0,
    wouldDelete: 0,
  };
  const cutoff = new Date(Date.now() - opts.minAgeHours * 3600 * 1000);

  const projectRows = await router
    .system()
    .select({
      id: projects.id,
      slug: projects.slug,
      databaseUrl: projects.databaseUrl,
    })
    .from(projects);
  for (const project of projectRows) {
    const db = await router.forProject({
      id: project.id,
      slug: project.slug,
      database_url: project.databaseUrl,
    });
    const expired = await db
      .select()
      .from(pendingUploads)
      .where(lt(pendingUploads.expiresAt, cutoff));
    for (const row of expired) {
      const orphan = row.completedAt === null;
      if (opts.dryRun) {
        report.wouldDelete++;
        opts.log(
          `would drop ${project.slug} upload ${row.id}` +
            (orphan ? ` and delete object ${row.storageKey}` : " (completed)"),
        );
        continue;
      }
      if (orphan) {
        const head = await storage.head(row.storageKey);
        if (head) {
          await storage.delete(row.storageKey);
          report.deletedObjects++;
          opts.log(`deleted orphan object ${row.storageKey} (${project.slug})`);
        }
      }
      await db.delete(pendingUploads).where(eq(pendingUploads.id, row.id));
      report.droppedRows++;
    }
  }
  return report;
}
