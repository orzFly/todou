import type {
  ContestedInterval,
  PrefixClaimEntry,
  PrefixDirectory,
  ReferenceDirectory,
  SlugClaimEntry,
} from "@todou/shared";
import { desc, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext, DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { refFormats } from "../db/project-schema.ts";
import { projects, refPrefixes, slugHistory } from "../db/system-schema.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  routeInfoOf,
} from "./access.ts";

/** Open end of a hold, so "still held" sorts after every real timestamp. */
const OPEN = Number.POSITIVE_INFINITY;

type FormatRow = { prefix: string | null; effectiveFrom: Date };

/**
 * Newest mirror row first, written once and shared by every reader of the
 * mirror. The tie-break on id is what keeps the answer from following the
 * order the database happened to return: two switches stamped inside the
 * same millisecond are ordinary on PGlite, whose clock stops there.
 */
const NEWEST_FIRST = [
  desc(refPrefixes.effectiveFrom),
  desc(refPrefixes.id),
] as const;

/** A prefix a project holds right now. Nothing closed is published any more. */
type CurrentHold = { prefix: string; slug: string; from: Date };

export async function mirrorRefFormat(
  db: Db,
  projectId: number,
  row: FormatRow,
): Promise<void> {
  await db.insert(refPrefixes).values({
    projectId,
    prefix: row.prefix,
    effectiveFrom: row.effectiveFrom,
  });
}

/**
 * Why there is no unique constraint on `ref_prefixes` to lean on instead, and
 * no `onConflictDoNothing` in `mirrorRefFormat`: the key would have to be
 * this truncated copy. The project's own `effective_from` has microsecond
 * resolution and the mirror's is cut to whole milliseconds by the driver, so
 * a key built here would permanently collapse two real switches made inside
 * the same millisecond into one row. A duplicate row is tolerable; a missing
 * one is not, because since T-510 the newest row is what bare-prefix
 * resolution answers from — lose it and resolve returns 404.
 */
const rowKey = (row: FormatRow): string =>
  `${row.effectiveFrom.getTime()}:${JSON.stringify(row.prefix)}`;

/** A history row the mirror does not have a copy of. */
export type MirrorGap = {
  projectId: number;
  prefix: string | null;
  effectiveFrom: Date;
};

/**
 * One database's worth of the answer. Failure is per group and not per
 * project because a batched read either reaches that database or does not.
 */
export type MirrorGroupOutcome = {
  projects: ProjectRow[];
  missing: MirrorGap[];
  error?: unknown;
};

/**
 * What the mirror is missing for these projects, reading only. Shared by the
 * boot-time full re-copy and by the hourly drain of `pending_prefix_mirrors`
 * (T-511), so that there is one definition of "missing" rather than two that
 * can drift.
 *
 * A group that throws is returned as a failed outcome rather than rethrown:
 * letting it out would reject the whole `perDatabase` and throw away the
 * repairs every other database just computed.
 */
export async function mirrorPrefixGaps(
  ctx: AppContext,
  projects: ProjectRow[],
): Promise<MirrorGroupOutcome[]> {
  // Specification, not a micro-optimisation: `syncRefPrefixMirror` under the
  // default colocated placement must cost exactly the one `select … from
  // projects`, and drizzle compiles `inArray(col, [])` to `false` rather than
  // refusing it — so dropping this guard would not break anything loudly, it
  // would silently spend a second statement to learn what the caller already
  // knows.
  if (projects.length === 0) return [];
  const system = ctx.router.system();
  const ids = projects.map((project) => project.id);

  const mirrored: FormatRowOf[] = [];
  for (let at = 0; at < ids.length; at += MIRROR_CHUNK) {
    mirrored.push(
      ...(await system
        .select({
          projectId: refPrefixes.projectId,
          prefix: refPrefixes.prefix,
          effectiveFrom: refPrefixes.effectiveFrom,
        })
        .from(refPrefixes)
        .where(
          inArray(refPrefixes.projectId, ids.slice(at, at + MIRROR_CHUNK)),
        )),
    );
  }
  const seen = new Map<number, Set<string>>();
  for (const row of mirrored) {
    const held = seen.get(row.projectId) ?? new Set<string>();
    held.add(rowKey(row));
    seen.set(row.projectId, held);
  }

  return ctx.router.perDatabase(projects, routeInfoOf, async (db, group) => {
    try {
      const source = await db
        .select({
          projectId: refFormats.projectId,
          prefix: refFormats.prefix,
          effectiveFrom: refFormats.effectiveFrom,
        })
        .from(refFormats)
        .where(
          inArray(
            refFormats.projectId,
            group.map((project) => project.id),
          ),
        );
      return {
        projects: group,
        missing: source.filter(
          (row) => !seen.get(row.projectId)?.has(rowKey(row)),
        ),
      };
    } catch (error) {
      return { projects: group, missing: [], error };
    }
  });
}

type FormatRowOf = FormatRow & { projectId: number };

/**
 * Copy every gap these outcomes found into the mirror, and say how many rows
 * that was.
 */
export async function writeMirrorGaps(
  ctx: AppContext,
  outcomes: readonly MirrorGroupOutcome[],
): Promise<number> {
  const gaps = outcomes.flatMap((outcome) => outcome.missing);
  // drizzle throws on `values([])`, so without this guard "nothing to repair"
  // would be a 500.
  if (gaps.length === 0) return 0;
  const system = ctx.router.system();
  // Chunked because the parameter list grows with the number of gaps, and
  // PostgreSQL refuses a statement carrying more than 65535 of them; a
  // first-boot backfill after a long outage is exactly the case that reaches
  // that ceiling.
  for (let at = 0; at < gaps.length; at += MIRROR_CHUNK) {
    await system.insert(refPrefixes).values(
      gaps.slice(at, at + MIRROR_CHUNK).map((row) => ({
        projectId: row.projectId,
        prefix: row.prefix,
        effectiveFrom: row.effectiveFrom,
      })),
    );
  }
  return gaps.length;
}

/**
 * Re-copy whatever the mirror is missing, for the projects that can still be
 * missing something: those in a database of their own. A colocated project
 * writes its history row and its mirror in one transaction, so it has no
 * half-landed state to repair — and no backfill either, this being the only
 * sweep that ever touched those rows. ref_formats is append-only, so
 * insert-only is complete.
 */
export async function syncRefPrefixMirror(ctx: AppContext): Promise<number> {
  const system = ctx.router.system();
  const rows = await system.select().from(projects);
  const createsAreColocated = ctx.router.newProjectSharesSystemDatabase();
  // Both clauses, not just the per-project one: a deployment whose placement
  // is dedicated never took the transactional branch in createProject, not
  // even for a project whose url happens to resolve back to the system
  // database — skipping that project would leave the one kind of gap nothing
  // else repairs.
  const remote = rows.filter(
    (project) =>
      !(
        createsAreColocated &&
        ctx.router.sharesSystemDatabase(routeInfoOf(project))
      ),
  );
  // Before the mirror read, not after it: under the default placement every
  // project is colocated, so this is the whole of a boot-path sweep that has
  // nothing to repair, and a `where project_id in ()` here would spend a
  // statement to learn what the filter already knows.
  if (remote.length === 0) return 0;

  const outcomes = await mirrorPrefixGaps(ctx, remote);
  const added = await writeMirrorGaps(ctx, outcomes);
  // Reported only after the repairs that did work have landed: one
  // unreachable database must not cost every other one its sweep.
  const failed = outcomes.find((outcome) => outcome.error !== undefined);
  if (failed) throw failed.error;
  return added;
}

/** Three bound parameters per mirror row, well under PostgreSQL's 65535. */
const MIRROR_CHUNK = 1000;

/**
 * Who holds which prefix right now, one row per project: the newest mirror
 * row, dropped when its prefix is NULL. A NULL newest row means the project
 * gave its prefix up; it does not fall back to the last prefix held.
 *
 * No `effective_from <= now()`: the rows are stamped by the database and the
 * question is asked by the application, so a row stamped ahead of this
 * process is still the prefix in force (T-360).
 *
 * The slug half below keeps its whole history on purpose; see `allSlugHolds`
 * for why the two halves differ.
 *
 * `distinct on` rather than the `lateral … limit 1` that `timeline.ts` uses
 * for the same "newest row" question: Sort+Unique reads its whole input, which
 * is waste when one key's tail is wanted and no waste at all here, where every
 * key's head is.
 */
async function currentHolds(ctx: DbContext): Promise<CurrentHold[]> {
  const rows = await ctx.router
    .system()
    .selectDistinctOn([projects.id], {
      slug: projects.slug,
      prefix: refPrefixes.prefix,
      effectiveFrom: refPrefixes.effectiveFrom,
    })
    .from(projects)
    .innerJoin(refPrefixes, eq(refPrefixes.projectId, projects.id))
    .orderBy(projects.id, ...NEWEST_FIRST);

  return rows.flatMap((row) =>
    row.prefix === null
      ? []
      : [{ prefix: row.prefix, slug: row.slug, from: row.effectiveFrom }],
  );
}

/**
 * The prefix each of these projects holds right now, by id. Shares
 * `NEWEST_FIRST` with the directory so that there is one answer to "which row
 * wins" rather than one per caller; a project with no mirror row is absent
 * from the map.
 */
export async function currentPrefixes(
  system: Db,
  ids: readonly number[],
): Promise<Map<number, string | null>> {
  const rows = await system
    .selectDistinctOn([refPrefixes.projectId], {
      projectId: refPrefixes.projectId,
      prefix: refPrefixes.prefix,
    })
    .from(refPrefixes)
    .where(inArray(refPrefixes.projectId, [...ids]))
    .orderBy(refPrefixes.projectId, ...NEWEST_FIRST);
  return new Map(rows.map((row) => [row.projectId, row.prefix]));
}

/**
 * The prefixes more than one project holds right now. `from` is the second
 * holder's own start, because every client asks whether `from <= now` and
 * would drop a window stamped at this instant on a clock a shade behind.
 */
function contestedNow(holds: CurrentHold[]): ContestedInterval[] {
  const byPrefix = new Map<string, CurrentHold[]>();
  for (const hold of holds) {
    const list = byPrefix.get(hold.prefix) ?? [];
    list.push(hold);
    byPrefix.set(hold.prefix, list);
  }
  const out: ContestedInterval[] = [];
  for (const [prefix, list] of byPrefix) {
    if (list.length < 2) continue;
    const froms = list.map((hold) => hold.from.getTime()).sort((a, b) => a - b);
    out.push({
      prefix,
      from: new Date(froms[1] as number).toISOString(),
      to: null,
    });
  }
  return out;
}

const entryOf = (hold: CurrentHold): PrefixClaimEntry => ({
  prefix: hold.prefix,
  slug: hold.slug,
  from: hold.from.toISOString(),
  to: null,
});

/**
 * Every project's current prefix. Extraction runs against this rather than a
 * viewer's slice: what it resolves is gated afterwards by the author check
 * and, at read time, by the viewer filter.
 */
export async function globalPrefixDirectory(
  ctx: DbContext,
): Promise<PrefixDirectory> {
  const holds = await currentHolds(ctx);
  return { entries: holds.map(entryOf), contested: contestedNow(holds) };
}

type SlugHold = {
  projectId: number;
  slug: string;
  canonical: string;
  from: number;
  to: number;
};

/**
 * One project's slug history turned into holds (T-156). Simpler than the
 * prefix version in two ways: a project always holds exactly one slug, so
 * every row closes the one before it, and there is no contested case — the
 * unique index on projects.slug means a slug has one holder at a time.
 */
function slugHoldsOf(
  projectId: number,
  canonical: string,
  history: { slug: string; effectiveFrom: Date }[],
): SlugHold[] {
  const sorted = [...history].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  );
  const holds: SlugHold[] = [];
  let open: SlugHold | null = null;
  for (const row of sorted) {
    const at = row.effectiveFrom.getTime();
    if (open !== null && open.slug === row.slug) continue;
    if (open !== null) open.to = at;
    open = { projectId, slug: row.slug, canonical, from: at, to: OPEN };
    holds.push(open);
  }
  // A rename inside the same millisecond as the one before it leaves an
  // interval covering no instant — noise in the payload, and a resolution
  // that can never fire.
  return holds.filter((hold) => hold.to > hold.from);
}

const slugEntryOf = (hold: SlugHold): SlugClaimEntry => ({
  slug: hold.slug,
  canonical: hold.canonical,
  from: new Date(hold.from).toISOString(),
  to: hold.to === OPEN ? null : new Date(hold.to).toISOString(),
});

/**
 * Every closed slug hold as well as the open one, deliberately asymmetric
 * with the prefix half next door: `resolveSlugAt` in
 * `shared/src/references-grammar.ts` resolves a slug nobody holds now to
 * whoever had it last, because people keep typing the old name from memory
 * after a rename. Trimming this to current holders would delete that answer.
 */
async function allSlugHolds(ctx: DbContext): Promise<SlugHold[]> {
  const system = ctx.router.system();
  const [rows, projectRows] = await Promise.all([
    system
      .select({
        projectId: slugHistory.projectId,
        slug: slugHistory.slug,
        effectiveFrom: slugHistory.effectiveFrom,
      })
      .from(slugHistory),
    system.select({ id: projects.id, slug: projects.slug }).from(projects),
  ]);

  const history = new Map<number, { slug: string; effectiveFrom: Date }[]>();
  for (const row of rows) {
    const list = history.get(row.projectId) ?? [];
    list.push(row);
    history.set(row.projectId, list);
  }

  const holds: SlugHold[] = [];
  for (const project of projectRows) {
    const list = history.get(project.id);
    if (list !== undefined) {
      holds.push(...slugHoldsOf(project.id, project.slug, list));
    }
  }
  return holds;
}

/** Every project's slug holds, for the extraction path. */
export async function globalSlugEntries(
  ctx: DbContext,
): Promise<SlugClaimEntry[]> {
  return (await allSlugHolds(ctx)).map(slugEntryOf);
}

/**
 * The prefix directory as this viewer may see it: their own projects'
 * holds by name, and every globally contested window anonymised. Contested
 * windows have to ship in full — a viewer who can see only one of several
 * holders would otherwise resolve a prefix the server refuses to.
 */
export async function referenceDirectory(
  ctx: AppContext,
  actor: UserRow,
): Promise<ReferenceDirectory> {
  const [holds, slugHolds, readable] = await Promise.all([
    currentHolds(ctx),
    allSlugHolds(ctx),
    accessibleProjectRows(ctx, actor),
  ]);
  const visible = new Set(readable.map((row) => row.slug));
  const visibleIds = new Set(readable.map((row) => row.id));
  return {
    entries: holds.filter((hold) => visible.has(hold.slug)).map(entryOf),
    contested: contestedNow(holds),
    // No contested counterpart: a slug has one holder at a time, so a
    // viewer who can see the holder can resolve it on their own.
    slug_entries: slugHolds
      .filter((hold) => visibleIds.has(hold.projectId))
      .map(slugEntryOf),
  };
}
