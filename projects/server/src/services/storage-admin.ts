import { and, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { ProjectRouteInfo } from "../config.ts";
import type { Db } from "../db/driver.ts";
import { attachments, pendingUploads } from "../db/project-schema.ts";
import type { DbRouter } from "../db/router.ts";
import {
  blobReaps,
  draftAttachmentMarks,
  projects,
  users,
} from "../db/system-schema.ts";
import { S3Storage } from "../storage/s3.ts";
import type { StorageBackend, StoredObject } from "../storage/types.ts";

/** Same margin as `storage gc`'s default: a presigned PUT still in flight
 * when its URL expires gets a day to be completed. */
export const UPLOAD_GC_MIN_AGE_HOURS = 24;

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
 * slow-but-legitimate upload is never reaped mid-flight) and deletes the
 * object at each row's upload key, unless an attachment still lives there.
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
        // Completed since T-653, the attachment is a copy elsewhere and the
        // upload key holds at most what a replayed ticket wrote. Completed
        // before it, the attachment lives at the upload key itself, and may
        // since have moved to another project's database where
        // `isRegistered` cannot see it — so those objects are left alone.
        const orphan = row.completedAt === null || row.attachmentKey !== null;
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
        // A complete from a server older than T-653 that commits after the
        // select above registers the object while this row still reads as
        // an orphan; the attachment row is what says the object is no
        // longer ours to delete.
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
 *
 * Only projects in `draft_attachment_marks` are opened, so a tick where no
 * project holds a draft costs one system read and touches no project
 * database (the hourly tick's N-independence, which the prefix-mirror tests
 * pin). A mark is dropped once its project has no drafts left and nothing
 * has refreshed it for `MARK_QUIET_MS`; see the table for why that is safe.
 */
/**
 * How long a mark must sit unrefreshed before it may be dropped: far longer
 * than any request takes between marking and writing its draft, which is
 * the window a cleared mark would otherwise leave a draft unwatched in.
 */
const MARK_QUIET_MS = 60 * 60 * 1000;

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

  const quietSince = new Date(Date.now() - MARK_QUIET_MS);

  const projectRows = await router
    .system()
    .select({
      id: projects.id,
      slug: projects.slug,
      databaseUrl: projects.databaseUrl,
      generation: draftAttachmentMarks.generation,
      markedAt: draftAttachmentMarks.markedAt,
    })
    .from(draftAttachmentMarks)
    .innerJoin(projects, eq(projects.id, draftAttachmentMarks.projectId));
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
      if (project.markedAt >= quietSince) continue;
      const left = await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(
          and(
            eq(attachments.projectId, project.id),
            eq(attachments.draft, true),
          ),
        )
        .limit(1);
      if (left.length > 0) continue;
      await router
        .system()
        .delete(draftAttachmentMarks)
        .where(
          and(
            eq(draftAttachmentMarks.projectId, project.id),
            eq(draftAttachmentMarks.generation, project.generation),
          ),
        );
    } catch (cause) {
      report.failedProjects++;
      opts.log(`FAIL ${project.slug}: ${String(cause)}`);
    }
  }
  return report;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type BlobReapEntry = {
  key: string;
  kind: "attachment" | "upload" | "icon";
  projectId: number;
  deleteAfter: Date;
};

const KEY_BATCH = 1000;

/**
 * Add keys to `blob_reaps` (T-659). A key listed twice keeps its first kind
 * and the later of the two deadlines, whether the duplicate is in this call
 * or already in the table. It has to be folded here as well as in SQL,
 * because Postgres refuses an `ON CONFLICT DO UPDATE` that meets one key
 * twice in a statement — and a project's upload row completed before T-653
 * names its attachment's own key, so duplicates are the normal case.
 */
export async function enlistBlobs(
  tx: Db | Tx,
  entries: BlobReapEntry[],
): Promise<void> {
  const byKey = new Map<string, BlobReapEntry>();
  for (const entry of entries) {
    const seen = byKey.get(entry.key);
    if (!seen) byKey.set(entry.key, entry);
    else if (entry.deleteAfter > seen.deleteAfter) {
      byKey.set(entry.key, { ...seen, deleteAfter: entry.deleteAfter });
    }
  }
  const rows = [...byKey.values()];
  for (let i = 0; i < rows.length; i += KEY_BATCH) {
    await tx
      .insert(blobReaps)
      .values(rows.slice(i, i + KEY_BATCH))
      .onConflictDoUpdate({
        target: blobReaps.key,
        set: {
          deleteAfter: sql`greatest(${blobReaps.deleteAfter}, excluded.delete_after)`,
        },
      });
  }
}

export type BlobReapReport = {
  deletedObjects: number;
  droppedRows: number;
  /** Rows left in place: an upload key not yet due, or one off s3. */
  kept: number;
  wouldDelete: number;
  failed: number;
};

/**
 * Delete the objects `blob_reaps` lists, then their rows (T-659).
 *
 * Without `projectId` only rows past their deadline are read, so a tick with
 * nothing due costs one system query and opens no project database. With it,
 * every row of that project is processed whatever its deadline — the
 * deletion path's immediate pass: an upload key not yet due loses its object
 * now and keeps its row for the delete after its ticket stops writing.
 *
 * An attachment or upload key that a live project's attachment row still
 * names belongs to that attachment: a moved card's attachments keep their
 * key in the target database, and an upload completed before T-653 is an
 * attachment at its upload key. Such a row is dropped and the object left
 * alone. When any live project's database cannot be read, nothing is deleted
 * this round, because "nobody registers it" is then unproven.
 *
 * Object before row, as in `gcPendingUploads`: the row is the only inventory
 * of the object. Several passes may walk the same rows; deleting an absent
 * object or row is a no-op, and only the pass whose DELETE returned the row
 * counts it.
 */
export async function reapBlobs(
  router: DbRouter,
  storage: StorageBackend,
  opts: { dryRun: boolean; projectId?: number; log: (line: string) => void },
): Promise<BlobReapReport> {
  const report: BlobReapReport = {
    deletedObjects: 0,
    droppedRows: 0,
    kept: 0,
    wouldDelete: 0,
    failed: 0,
  };
  const system = router.system();
  const now = new Date();
  const rows = await system
    .select()
    .from(blobReaps)
    .where(
      opts.projectId === undefined
        ? lte(blobReaps.deleteAfter, now)
        : eq(blobReaps.projectId, opts.projectId),
    );
  if (rows.length === 0) return report;

  // Upload keys off s3 name objects in a bucket this process no longer talks
  // to; dropping the row would lose the only list of them, the same reason
  // `gcPendingUploads` refuses them.
  const offS3 = !(storage instanceof S3Storage);
  const actionable = rows.filter((row) => {
    if (offS3 && row.kind === "upload") {
      report.kept++;
      return false;
    }
    return true;
  });

  let registered: Set<string>;
  try {
    registered = await registeredKeys(
      router,
      // Icons are never shared: every upload mints a new key.
      actionable.filter((row) => row.kind !== "icon").map((row) => row.key),
    );
  } catch (cause) {
    report.failed++;
    opts.log(
      `FAIL blob reaping: a live project is unreadable: ${String(cause)}`,
    );
    return report;
  }

  const drop = async (key: string, dueOnly: boolean) => {
    const dropped = await system
      .delete(blobReaps)
      .where(
        and(
          eq(blobReaps.key, key),
          // A concurrent deletion may have re-enlisted the key with a later
          // deadline meanwhile; that row is not ours to drop.
          dueOnly ? lte(blobReaps.deleteAfter, now) : undefined,
        ),
      )
      .returning({ key: blobReaps.key });
    report.droppedRows += dropped.length;
  };

  for (const row of actionable) {
    if (registered.has(row.key)) {
      if (opts.dryRun) {
        opts.log(`would drop the row of ${row.key}, a live attachment's`);
        continue;
      }
      await drop(row.key, false);
      continue;
    }
    const subject = `${row.kind} object ${row.key} of deleted project ${row.projectId}`;
    if (opts.dryRun) {
      report.wouldDelete++;
      opts.log(`would delete ${subject}`);
      continue;
    }
    try {
      await storage.delete(row.key);
      report.deletedObjects++;
    } catch (cause) {
      report.failed++;
      opts.log(`FAIL ${subject}: ${String(cause)}`);
      continue;
    }
    if (row.deleteAfter <= now) await drop(row.key, true);
    else report.kept++;
  }
  return report;
}

/**
 * Which of `keys` a live project's attachment row names: one query per
 * database and batch of keys, filtered to the live projects on it, so a
 * deleted project's own rows that failed to go do not count.
 */
async function registeredKeys(
  router: DbRouter,
  keys: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (keys.length === 0) return found;
  const byUrl = new Map<string, ProjectRouteInfo[]>();
  const live = await router
    .system()
    .select({
      id: projects.id,
      slug: projects.slug,
      databaseUrl: projects.databaseUrl,
    })
    .from(projects);
  for (const row of live) {
    const info = { id: row.id, slug: row.slug, database_url: row.databaseUrl };
    const url = router.resolveProjectUrl(info);
    byUrl.set(url, [...(byUrl.get(url) ?? []), info]);
  }
  for (const infos of byUrl.values()) {
    const [first] = infos;
    if (!first) continue;
    const db = await router.forProject(first);
    const ids = infos.map((info) => info.id);
    for (let i = 0; i < keys.length; i += KEY_BATCH) {
      const hits = await db
        .select({ key: attachments.storageKey })
        .from(attachments)
        .where(
          and(
            inArray(attachments.storageKey, keys.slice(i, i + KEY_BATCH)),
            inArray(attachments.projectId, ids),
          ),
        );
      for (const hit of hits) found.add(hit.key);
    }
  }
  return found;
}

/**
 * The key shapes this server mints: `aa/bb/<uuid>` for attachments and
 * upload keys, under `avatars/` or `project-icons/` for those, with the two
 * directories the uuid's first four hex digits. A bucket shared with other
 * software keeps every other object out of `storage orphans` by this alone.
 */
const MINTED_KEY =
  /^(?:avatars\/|project-icons\/)?([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function isMintedKey(key: string): boolean {
  const match = MINTED_KEY.exec(key);
  return match !== null && `${match[1]}${match[2]}` === match[3]?.slice(0, 4);
}

/**
 * Every key some database still answers for: avatars, icons and every live
 * project's attachments, each live project's upload keys and their
 * attachment copies, and everything `blob_reaps` lists (the reaper's to
 * delete, on its own schedule). Throws when any project database cannot be
 * read — a partial set would make that project's files look orphaned.
 */
async function knownKeys(router: DbRouter): Promise<Set<string>> {
  const known = new Set((await enumerateBlobKeys(router)).map((k) => k.key));
  const live = await router
    .system()
    .select({
      id: projects.id,
      slug: projects.slug,
      databaseUrl: projects.databaseUrl,
    })
    .from(projects);
  for (const project of live) {
    const db = await router.forProject({
      id: project.id,
      slug: project.slug,
      database_url: project.databaseUrl,
    });
    const uploads = await db
      .select({
        key: pendingUploads.storageKey,
        attachmentKey: pendingUploads.attachmentKey,
      })
      .from(pendingUploads)
      .where(eq(pendingUploads.projectId, project.id));
    for (const row of uploads) {
      known.add(row.key);
      if (row.attachmentKey) known.add(row.attachmentKey);
    }
  }
  const listed = await router
    .system()
    .select({ key: blobReaps.key })
    .from(blobReaps);
  for (const row of listed) known.add(row.key);
  return known;
}

/**
 * Stored objects no database names (T-659): what projects deleted before
 * `blob_reaps` existed left behind, which nothing but the bucket itself can
 * find. Lists the whole store, so it is the operator's command and never a
 * periodic pass. Only keys of a shape this server mints are considered, and
 * only ones older than `minAgeHours` — a multipart upload or a draft writes
 * its object a moment before the row naming it commits.
 */
export async function findOrphanBlobs(
  router: DbRouter,
  storage: StorageBackend,
  opts: { minAgeHours: number },
): Promise<StoredObject[]> {
  const known = await knownKeys(router);
  const cutoff = Date.now() - opts.minAgeHours * 3600 * 1000;
  const orphans: StoredObject[] = [];
  for await (const object of storage.list()) {
    if (!isMintedKey(object.key)) continue;
    if (object.modifiedAt.getTime() >= cutoff) continue;
    if (known.has(object.key)) continue;
    orphans.push(object);
  }
  return orphans;
}

/**
 * Delete what `findOrphanBlobs` returned, after reading the known keys a
 * second time: a move in a shared database deletes the source row before it
 * inserts the target's, so one snapshot can fall between the two. Only keys
 * absent from both are deleted.
 */
export async function deleteOrphanBlobs(
  router: DbRouter,
  storage: StorageBackend,
  orphans: StoredObject[],
  opts: { log: (line: string) => void },
): Promise<{ deleted: number; skipped: number; failed: number }> {
  const report = { deleted: 0, skipped: 0, failed: 0 };
  const known = await knownKeys(router);
  for (const { key } of orphans) {
    if (known.has(key)) {
      report.skipped++;
      opts.log(`skip ${key}: named since it was listed`);
      continue;
    }
    try {
      await storage.delete(key);
      report.deleted++;
    } catch (cause) {
      report.failed++;
      opts.log(`FAIL ${key}: ${String(cause)}`);
    }
  }
  return report;
}
