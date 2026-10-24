import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { attachments, pendingUploads } from "../db/project-schema.ts";
import type { DbRouter } from "../db/router.ts";
import { projects, users } from "../db/system-schema.ts";
import type { StorageBackend } from "../storage/types.ts";

export type BlobKey = { key: string; origin: string };

/**
 * Every blob key the deployment knows about: avatars and project icons from
 * the system database plus attachments from every project database. This
 * enumeration — not a bucket listing — is the source of truth for migration,
 * so the tool scales with the database, never with bucket size.
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
      iconKey: projects.iconKey,
    })
    .from(projects);
  for (const project of projectRows) {
    if (project.iconKey) {
      keys.push({ key: project.iconKey, origin: `icon:${project.slug}` });
    }
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
  failedProjects: number;
};

/**
 * Walks pending_uploads rows past their expiry (plus a safety margin so a
 * slow-but-legitimate upload is never reaped mid-flight): uncompleted rows
 * are orphan candidates whose objects get deleted; completed rows just get
 * dropped — their object is a registered attachment now.
 *
 * Runs from the hourly housekeeping tick on every instance as well as from
 * `storage gc`, so several passes may walk the same rows at once. Deleting
 * an absent object and an absent row are both no-ops, and only the pass
 * whose DELETE returned the row counts it. The object goes before the row
 * because the row is the only inventory of that object: a failed object
 * delete has to leave the row for the next pass to retry.
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
    failedProjects: 0,
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
    // One unreachable project database must not starve every project after
    // it in the walk, tick after tick.
    try {
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
              (orphan
                ? ` and delete object ${row.storageKey}`
                : " (completed)"),
          );
          continue;
        }
        // A complete that commits after the select above registers the
        // object while this row still reads as an orphan; the attachment
        // row is what says the object is no longer ours to delete.
        if (orphan && !(await isRegistered(db, row.storageKey))) {
          const head = await storage.head(row.storageKey);
          if (head) {
            await storage.delete(row.storageKey);
            report.deletedObjects++;
            opts.log(
              `deleted orphan object ${row.storageKey} (${project.slug})`,
            );
          }
        }
        const dropped = await db
          .delete(pendingUploads)
          .where(eq(pendingUploads.id, row.id))
          .returning({ id: pendingUploads.id });
        report.droppedRows += dropped.length;
      }
    } catch (cause) {
      report.failedProjects++;
      opts.log(`FAIL ${project.slug}: ${String(cause)}`);
    }
  }
  return report;
}

async function isRegistered(db: Db, storageKey: string): Promise<boolean> {
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.storageKey, storageKey))
    .limit(1);
  return rows.length > 0;
}

export type DraftReapReport = {
  deletedRows: number;
  deletedObjects: number;
  wouldDelete: number;
  failedProjects: number;
};

/**
 * Deletes draft attachments (T-568) older than `minAgeHours`: files an
 * editor uploaded for a text that was never sent, which nobody but their
 * uploader ever saw.
 *
 * Unlike `gcPendingUploads` the row goes first, because a draft can still be
 * claimed: a text that links it turns it into an attachment with one
 * `UPDATE … WHERE draft`, and the `DELETE … WHERE draft` here races that
 * statement for the row. Whichever commits first keeps it, so this pass never
 * deletes the bytes of a file a text just made public. The cost is that an
 * object whose delete fails has no row left to retry from; it is logged.
 *
 * Every backend, not only s3: drafts come from the multipart route too.
 */
export async function reapDraftAttachments(
  router: DbRouter,
  storage: StorageBackend,
  opts: { dryRun: boolean; minAgeHours: number; log: (line: string) => void },
): Promise<DraftReapReport> {
  const report: DraftReapReport = {
    deletedRows: 0,
    deletedObjects: 0,
    wouldDelete: 0,
    failedProjects: 0,
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
    try {
      const db = await router.forProject({
        id: project.id,
        slug: project.slug,
        database_url: project.databaseUrl,
      });
      const stale = and(
        eq(attachments.projectId, project.id),
        eq(attachments.draft, true),
        lt(attachments.createdAt, cutoff),
      );
      if (opts.dryRun) {
        const rows = await db
          .select({ id: attachments.id, key: attachments.storageKey })
          .from(attachments)
          .where(stale);
        for (const row of rows) {
          report.wouldDelete++;
          opts.log(
            `would delete ${project.slug} draft attachment ${row.id} and object ${row.key}`,
          );
        }
        continue;
      }
      const deleted = await db
        .delete(attachments)
        .where(stale)
        .returning({ id: attachments.id, key: attachments.storageKey });
      report.deletedRows += deleted.length;
      for (const row of deleted) {
        try {
          await storage.delete(row.key);
          report.deletedObjects++;
          opts.log(
            `deleted draft attachment ${row.id} and object ${row.key} (${project.slug})`,
          );
        } catch (cause) {
          opts.log(
            `FAIL object ${row.key} of draft attachment ${row.id} (${project.slug}): ${String(cause)}`,
          );
        }
      }
    } catch (cause) {
      report.failedProjects++;
      opts.log(`FAIL ${project.slug}: ${String(cause)}`);
    }
  }
  return report;
}
