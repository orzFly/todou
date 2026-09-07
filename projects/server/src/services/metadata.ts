import {
  type ChangeAction,
  type IssueMetadataEntry,
  type IssueMetadataList,
  type IssueMetadataNamespaceList,
  type IssueMetadataWriteInput,
  METADATA_KEYS_PER_NAMESPACE,
  METADATA_NAMESPACES_PER_ISSUE,
  type MetadataNamespaceSelector,
  type UserRef,
} from "@todou/shared";
import { and, asc, count, eq, inArray, max, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { issueMetadata, issues } from "../db/project-schema.ts";
import {
  MetadataPreconditionError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { projectForRead, requireCapability, routeInfoOf } from "./access.ts";
import {
  assertIssueReadable,
  assertIssueWritable,
  gateColumns,
} from "./trash.ts";
import { getUserRefs } from "./users.ts";

/**
 * Metadata: machine-written state hung off an issue (T-282). The server never
 * parses a value, and read permission has a single level — see the header of
 * `schemas/metadata.ts` for what rests on those two.
 */

/**
 * The card by number, gate columns only. A local loader rather than
 * `loadIssueRow`: the bundled `?metadata=` read has `issues.ts` importing
 * this module, and one direction of that pair has to stay clear.
 */
async function loadIssue(db: Db, projectId: number, number: number) {
  const rows = await db
    .select({ ...gateColumns })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
  const row = rows[0];
  if (!row) throw new NotFoundError("issue not found");
  return row;
}

/** `WHERE namespace IN (…)`, or nothing at all when the caller asked for `*`. */
function namespaceFilter(selector: MetadataNamespaceSelector) {
  return selector === "*"
    ? undefined
    : inArray(issueMetadata.namespace, selector);
}

export type MetadataRow = {
  issueId: number;
  namespace: string;
  key: string;
  value: string;
  updatedAt: Date;
  updatedBy: number;
};

/**
 * The stored rows for a set of issues, in `(namespace, key)` order. That
 * order is contract rather than coincidence: the web table groups by
 * namespace straight off the array it is given.
 *
 * Rows rather than finished entries, and issue ids rather than one issue,
 * because the bundled `?metadata=` read shares this: a page of thirty cards
 * is one query, and resolving the writers is folded into the user lookup that
 * page already makes.
 */
export async function metadataRowsFor(
  db: Db,
  issueIds: number[],
  selector: MetadataNamespaceSelector,
): Promise<MetadataRow[]> {
  if (issueIds.length === 0) return [];
  return db
    .select({
      issueId: issueMetadata.issueId,
      namespace: issueMetadata.namespace,
      key: issueMetadata.key,
      value: issueMetadata.value,
      updatedAt: issueMetadata.updatedAt,
      updatedBy: issueMetadata.updatedBy,
    })
    .from(issueMetadata)
    .where(
      and(inArray(issueMetadata.issueId, issueIds), namespaceFilter(selector)),
    )
    .orderBy(asc(issueMetadata.namespace), asc(issueMetadata.key));
}

/** Those rows as DTO entries, grouped by issue and keeping their order. */
export function metadataEntriesByIssue(
  issueIds: number[],
  rows: MetadataRow[],
  refs: Map<number, UserRef>,
): Map<number, IssueMetadataEntry[]> {
  const byIssue = new Map<number, IssueMetadataEntry[]>();
  for (const id of issueIds) byIssue.set(id, []);
  for (const row of rows) {
    byIssue.get(row.issueId)?.push({
      namespace: row.namespace,
      key: row.key,
      value: row.value,
      updated_at: row.updatedAt.toISOString(),
      updated_by: refs.get(row.updatedBy) as UserRef,
    });
  }
  return byIssue;
}

export async function readIssueMetadata(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  selector: MetadataNamespaceSelector,
): Promise<IssueMetadataList> {
  // Addressed, like every other read hanging off a card: the metadata travels
  // with it, so an old address earns the redirect before the reader's role
  // here is known (T-242).
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueReadable(issue, actor, role);

  const rows = await metadataRowsFor(db, [issue.id], selector);
  const refs = await getUserRefs(
    ctx.router.system(),
    rows.map((row) => row.updatedBy),
  );
  const byIssue = metadataEntriesByIssue([issue.id], rows, refs);
  return { entries: byIssue.get(issue.id) ?? [] };
}

export async function listIssueMetadataNamespaces(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<IssueMetadataNamespaceList> {
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueReadable(issue, actor, role);

  const rows = await db
    .select({
      namespace: issueMetadata.namespace,
      keys: count(),
      updatedAt: max(issueMetadata.updatedAt),
    })
    .from(issueMetadata)
    .where(eq(issueMetadata.issueId, issue.id))
    .groupBy(issueMetadata.namespace)
    .orderBy(asc(issueMetadata.namespace));

  return {
    namespaces: rows.map((row) => ({
      namespace: row.namespace,
      keys: row.keys,
      // A group exists only because it holds rows, so the aggregate is never
      // null in practice; the driver's type does not know that.
      updated_at: (row.updatedAt ?? new Date()).toISOString(),
    })),
  };
}

/** One key this request actually moved, ready to become an event. */
type Change = {
  namespace: string;
  key: string;
  value: string | null;
  action: ChangeAction;
};

type Failure = { namespace: string; key: string };

export async function writeIssueMetadata(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: IssueMetadataWriteInput,
): Promise<IssueMetadataList> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "metadata.write",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  // The same gate every other write passes: frozen in the trash, frozen while
  // the card is being copied elsewhere, redirected once it has moved. Writing
  // silently does not make it exempt — a write during the move window is
  // deleted by the source-side cleanup, which is real data loss.
  assertIssueWritable(issue, actor, role);

  const touched = [...new Set(input.entries.map((e) => e.namespace))];
  // One stamp for the whole request, so a multi-key write does not spread
  // itself over a few milliseconds, and so the events can carry the value
  // without reading the rows back.
  const writtenAt = new Date();

  const changes = await db.transaction(async (tx) => {
    const before = await tx
      .select({
        namespace: issueMetadata.namespace,
        key: issueMetadata.key,
        value: issueMetadata.value,
      })
      .from(issueMetadata)
      .where(
        and(
          eq(issueMetadata.issueId, issue.id),
          inArray(issueMetadata.namespace, touched),
        ),
      );
    const existing = new Map(
      before.map((row) => [`${row.namespace}/${row.key}`, row.value]),
    );

    const applied: Change[] = [];
    const failed: Failure[] = [];
    const ids = {
      issueId: issue.id,
      projectId: project.id,
      actorId: actor.id,
      writtenAt,
    };
    for (const entry of input.entries) {
      const had = existing.get(`${entry.namespace}/${entry.key}`);
      const outcome =
        entry.if_match === undefined
          ? await applyUnconditional(tx, entry, ids)
          : await applyConditional(tx, entry, entry.if_match, ids);

      if (outcome === "failed") {
        failed.push({ namespace: entry.namespace, key: entry.key });
        continue;
      }
      if (outcome === "unchanged") continue;
      applied.push({
        namespace: entry.namespace,
        key: entry.key,
        value: entry.value,
        action:
          entry.value === null
            ? "deleted"
            : had === undefined
              ? "created"
              : "updated",
      });
    }

    if (failed.length > 0) {
      // Read the current values now rather than reusing the snapshot above:
      // what the caller retries against has to be what is stored, and the
      // rollback below undoes everything this transaction did anyway.
      throw new MetadataPreconditionError(
        await currentValues(tx, issue.id, failed),
      );
    }

    await assertWithinQuota(tx, issue.id);

    const entries = await tx
      .select({
        namespace: issueMetadata.namespace,
        key: issueMetadata.key,
        value: issueMetadata.value,
        updatedAt: issueMetadata.updatedAt,
        updatedBy: issueMetadata.updatedBy,
      })
      .from(issueMetadata)
      .where(
        and(
          eq(issueMetadata.issueId, issue.id),
          inArray(issueMetadata.namespace, touched),
        ),
      )
      .orderBy(asc(issueMetadata.namespace), asc(issueMetadata.key));

    return { applied, entries };
  });

  const refs = await getUserRefs(ctx.router.system(), [
    actor.id,
    ...changes.entries.map((row) => row.updatedBy),
  ]);
  const writer = refs.get(actor.id) as UserRef;

  // After the commit, the way every other publisher on this bus does it.
  for (const change of changes.applied) {
    ctx.bus.publish(project.id, {
      entity: "metadata",
      // The issue's id: a metadata entry has no surrogate id of its own.
      id: issue.id,
      action: change.action,
      issue_number: issueNumber,
      metadata: {
        namespace: change.namespace,
        key: change.key,
        value: change.value,
        updated_at: writtenAt.toISOString(),
        updated_by: writer,
      },
    });
  }

  return {
    entries: changes.entries.map((row) => ({
      namespace: row.namespace,
      key: row.key,
      value: row.value,
      updated_at: row.updatedAt.toISOString(),
      updated_by: refs.get(row.updatedBy) as UserRef,
    })),
  };
}

type WriteIds = {
  issueId: number;
  projectId: number;
  actorId: number;
  writtenAt: Date;
};

type Outcome = "changed" | "unchanged" | "failed";

/**
 * No `if_match`: store the value, or delete the key, whatever is there now.
 *
 * The `WHERE` on the DO UPDATE is what makes replaying a state free — an
 * orchestrator restarting and writing the values it already wrote must not
 * bump `updated_at` or wake a single subscriber.
 */
async function applyUnconditional(
  tx: Db,
  entry: { namespace: string; key: string; value: string | null },
  ids: WriteIds,
): Promise<Outcome> {
  if (entry.value === null) {
    const deleted = await tx
      .delete(issueMetadata)
      .where(keyIs(ids.issueId, entry))
      .returning({ key: issueMetadata.key });
    return deleted.length > 0 ? "changed" : "unchanged";
  }
  const written = await tx
    .insert(issueMetadata)
    .values({
      projectId: ids.projectId,
      issueId: ids.issueId,
      namespace: entry.namespace,
      key: entry.key,
      value: entry.value,
      updatedAt: ids.writtenAt,
      updatedBy: ids.actorId,
    })
    .onConflictDoUpdate({
      target: [
        issueMetadata.issueId,
        issueMetadata.namespace,
        issueMetadata.key,
      ],
      set: {
        value: entry.value,
        updatedAt: ids.writtenAt,
        updatedBy: ids.actorId,
      },
      setWhere: sql`${issueMetadata.value} <> ${entry.value}`,
    })
    .returning({ key: issueMetadata.key });
  return written.length > 0 ? "changed" : "unchanged";
}

/**
 * With `if_match`: the expectation is carried by the statement itself rather
 * than by a read followed by a write, so no extra lock is needed and a
 * concurrent second request simply queues behind the row lock.
 *
 *   expect absent → INSERT … ON CONFLICT DO NOTHING; nothing inserted = lost.
 *   expect a value → UPDATE/DELETE … WHERE value = …; no row = lost.
 *
 * The one case with no statement to run is "expect X and store X": there is
 * nothing to write, only something to verify, and writing anyway would bump
 * `updated_at` for a value that did not move.
 */
async function applyConditional(
  tx: Db,
  entry: { namespace: string; key: string; value: string | null },
  expected: string | null,
  ids: WriteIds,
): Promise<Outcome> {
  if (expected === null) {
    if (entry.value === null) {
      // Delete a key that is expected not to exist: nothing to do, as long as
      // it really is absent.
      const rows = await tx
        .select({ value: issueMetadata.value })
        .from(issueMetadata)
        .where(keyIs(ids.issueId, entry));
      return rows.length === 0 ? "unchanged" : "failed";
    }
    const inserted = await tx
      .insert(issueMetadata)
      .values({
        projectId: ids.projectId,
        issueId: ids.issueId,
        namespace: entry.namespace,
        key: entry.key,
        value: entry.value,
        updatedAt: ids.writtenAt,
        updatedBy: ids.actorId,
      })
      .onConflictDoNothing()
      .returning({ key: issueMetadata.key });
    return inserted.length > 0 ? "changed" : "failed";
  }

  if (entry.value === null) {
    const deleted = await tx
      .delete(issueMetadata)
      .where(and(keyIs(ids.issueId, entry), eq(issueMetadata.value, expected)))
      .returning({ key: issueMetadata.key });
    return deleted.length > 0 ? "changed" : "failed";
  }

  if (expected === entry.value) {
    const rows = await tx
      .select({ value: issueMetadata.value })
      .from(issueMetadata)
      .where(and(keyIs(ids.issueId, entry), eq(issueMetadata.value, expected)));
    return rows.length > 0 ? "unchanged" : "failed";
  }

  const updated = await tx
    .update(issueMetadata)
    .set({
      value: entry.value,
      updatedAt: ids.writtenAt,
      updatedBy: ids.actorId,
    })
    .where(and(keyIs(ids.issueId, entry), eq(issueMetadata.value, expected)))
    .returning({ key: issueMetadata.key });
  return updated.length > 0 ? "changed" : "failed";
}

function keyIs(issueId: number, entry: { namespace: string; key: string }) {
  return and(
    eq(issueMetadata.issueId, issueId),
    eq(issueMetadata.namespace, entry.namespace),
    eq(issueMetadata.key, entry.key),
  );
}

/** What is stored right now under each key whose expectation did not hold. */
async function currentValues(
  tx: Db,
  issueId: number,
  failed: Failure[],
): Promise<Array<{ namespace: string; key: string; current: string | null }>> {
  const rows = await tx
    .select({
      namespace: issueMetadata.namespace,
      key: issueMetadata.key,
      value: issueMetadata.value,
    })
    .from(issueMetadata)
    .where(
      and(
        eq(issueMetadata.issueId, issueId),
        inArray(
          issueMetadata.namespace,
          failed.map((f) => f.namespace),
        ),
      ),
    );
  const stored = new Map(
    rows.map((row) => [`${row.namespace}/${row.key}`, row.value]),
  );
  return failed.map((f) => ({
    namespace: f.namespace,
    key: f.key,
    current: stored.get(`${f.namespace}/${f.key}`) ?? null,
  }));
}

/**
 * The per-card guard rails, checked inside the transaction after the writes
 * have landed so the question is about the resulting state rather than about
 * what the request looked like.
 *
 * Two concurrent transactions can each pass this and overshoot together by a
 * little. That is what a guard rail may cost; raising the numbers needs no
 * migration, and nothing downstream breaks at nine namespaces.
 */
async function assertWithinQuota(tx: Db, issueId: number): Promise<void> {
  const groups = await tx
    .select({ namespace: issueMetadata.namespace, keys: count() })
    .from(issueMetadata)
    .where(eq(issueMetadata.issueId, issueId))
    .groupBy(issueMetadata.namespace);

  if (groups.length > METADATA_NAMESPACES_PER_ISSUE) {
    throw new ValidationFailedError(
      `an issue may hold at most ${METADATA_NAMESPACES_PER_ISSUE} metadata namespaces`,
      { limit: "namespaces_per_issue", max: METADATA_NAMESPACES_PER_ISSUE },
    );
  }
  for (const group of groups) {
    if (group.keys > METADATA_KEYS_PER_NAMESPACE) {
      throw new ValidationFailedError(
        `a metadata namespace may hold at most ${METADATA_KEYS_PER_NAMESPACE} keys`,
        { limit: "keys_per_namespace", max: METADATA_KEYS_PER_NAMESPACE },
      );
    }
  }
}
