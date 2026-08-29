import type {
  ContestedInterval,
  PrefixClaimEntry,
  PrefixDirectory,
  ReferenceDirectory,
  SlugClaimEntry,
} from "@todou/shared";
import { eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { refFormats } from "../db/project-schema.ts";
import {
  projects,
  refPrefixes,
  slugHistory,
  systemSettings,
} from "../db/system-schema.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  routeInfoOf,
} from "./access.ts";

const CROSS_REFS_SINCE = "cross_refs_since";

/** Open end of a hold, so "still held" sorts after every real timestamp. */
const OPEN = Number.POSITIVE_INFINITY;

type FormatRow = { prefix: string | null; effectiveFrom: Date };
type Hold = { prefix: string; slug: string; from: number; to: number };

/**
 * The instant this deployment opened the cross-project grammar, seeded by
 * the migration that created the mirror. A missing row means the feature
 * is off — the whole grammar fails closed rather than guessing a cutoff.
 */
export async function crossRefsSince(db: Db): Promise<string | null> {
  const rows = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, CROSS_REFS_SINCE));
  const raw = rows[0]?.value;
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

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

const rowKey = (row: FormatRow): string =>
  `${row.effectiveFrom.getTime()}:${JSON.stringify(row.prefix)}`;

/**
 * Re-copy whatever the mirror is missing, project by project. This is the
 * repair path for a mirror write that failed after its project-database
 * write committed, and the one-time backfill for histories that predate
 * the mirror. ref_formats is append-only, so insert-only is complete.
 */
export async function syncRefPrefixMirror(ctx: AppContext): Promise<number> {
  const system = ctx.router.system();
  const rows = await system.select().from(projects);
  let added = 0;
  for (const project of rows) {
    added += await syncProject(ctx, project);
  }
  return added;
}

async function syncProject(
  ctx: AppContext,
  project: ProjectRow,
): Promise<number> {
  const system = ctx.router.system();
  const db = await ctx.router.forProject(routeInfoOf(project));
  const source = await db
    .select({
      prefix: refFormats.prefix,
      effectiveFrom: refFormats.effectiveFrom,
    })
    .from(refFormats)
    .where(eq(refFormats.projectId, project.id));
  const mirrored = await system
    .select({
      prefix: refPrefixes.prefix,
      effectiveFrom: refPrefixes.effectiveFrom,
    })
    .from(refPrefixes)
    .where(eq(refPrefixes.projectId, project.id));

  const seen = new Set(mirrored.map(rowKey));
  const missing = source.filter((row) => !seen.has(rowKey(row)));
  if (missing.length > 0) {
    await system.insert(refPrefixes).values(
      missing.map((row) => ({
        projectId: project.id,
        prefix: row.prefix,
        effectiveFrom: row.effectiveFrom,
      })),
    );
  }
  return missing.length;
}

/**
 * One project's history turned into holds. A NULL-prefix row holds
 * nothing; it exists to close the interval of the prefix before it.
 */
function holdsOf(slug: string, history: FormatRow[]): Hold[] {
  const sorted = [...history].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  );
  const holds: Hold[] = [];
  let open: Hold | null = null;
  for (const row of sorted) {
    const at = row.effectiveFrom.getTime();
    // A repeated prefix extends the current hold instead of opening a
    // second one, which would otherwise read as this project contesting
    // itself.
    if (open !== null && open.prefix === row.prefix) continue;
    if (open !== null) {
      open.to = at;
      open = null;
    }
    if (row.prefix !== null) {
      open = { prefix: row.prefix, slug, from: at, to: OPEN };
      holds.push(open);
    }
  }
  // Two switches inside the same millisecond collapse to an empty hold
  // once timestamps land in a JS Date; an interval that covers no instant
  // is noise in the payload and a phantom holder in the overlap sweep.
  return holds.filter((hold) => hold.to > hold.from);
}

/** The windows where a prefix had more than one holder, by sweep over its holds. */
function contestedWindows(holds: Hold[]): ContestedInterval[] {
  const byPrefix = new Map<string, Hold[]>();
  for (const hold of holds) {
    const list = byPrefix.get(hold.prefix) ?? [];
    list.push(hold);
    byPrefix.set(hold.prefix, list);
  }
  const out: ContestedInterval[] = [];
  for (const [prefix, list] of byPrefix) {
    // Closing before opening at an equal timestamp is what keeps two
    // back-to-back holds from reading as an instant of overlap.
    const events = list
      .flatMap((hold) => [
        { at: hold.from, delta: 1 },
        { at: hold.to, delta: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    let depth = 0;
    let start: number | null = null;
    for (const event of events) {
      const before = depth;
      depth += event.delta;
      if (before < 2 && depth >= 2) start = event.at;
      else if (before >= 2 && depth < 2 && start !== null) {
        if (event.at > start) out.push(interval(prefix, start, event.at));
        start = null;
      }
    }
    if (start !== null) out.push(interval(prefix, start, OPEN));
  }
  return out;
}

function interval(prefix: string, from: number, to: number): ContestedInterval {
  return {
    prefix,
    from: new Date(from).toISOString(),
    to: to === OPEN ? null : new Date(to).toISOString(),
  };
}

const entryOf = (hold: Hold): PrefixClaimEntry => ({
  ...interval(hold.prefix, hold.from, hold.to),
  slug: hold.slug,
});

/**
 * Every project's holds. Extraction runs against this rather than a
 * viewer's slice: what it resolves is gated afterwards by the author check
 * and, at read time, by the viewer filter.
 */
export async function globalPrefixDirectory(
  ctx: AppContext,
): Promise<PrefixDirectory> {
  const holds = await allHolds(ctx);
  return { entries: holds.map(entryOf), contested: contestedWindows(holds) };
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

async function allSlugHolds(ctx: AppContext): Promise<SlugHold[]> {
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
  ctx: AppContext,
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
  const system = ctx.router.system();
  const [holds, slugHolds, readable, since] = await Promise.all([
    allHolds(ctx),
    allSlugHolds(ctx),
    accessibleProjectRows(ctx, actor),
    crossRefsSince(system),
  ]);
  const visible = new Set(readable.map((row) => row.slug));
  const visibleIds = new Set(readable.map((row) => row.id));
  return {
    since,
    entries: holds.filter((hold) => visible.has(hold.slug)).map(entryOf),
    contested: contestedWindows(holds),
    // No contested counterpart: a slug has one holder at a time, so a
    // viewer who can see the holder can resolve it on their own.
    slug_entries: slugHolds
      .filter((hold) => visibleIds.has(hold.projectId))
      .map(slugEntryOf),
  };
}

async function allHolds(ctx: AppContext): Promise<Hold[]> {
  const system = ctx.router.system();
  const [rows, projectRows] = await Promise.all([
    system
      .select({
        projectId: refPrefixes.projectId,
        prefix: refPrefixes.prefix,
        effectiveFrom: refPrefixes.effectiveFrom,
      })
      .from(refPrefixes),
    system.select({ id: projects.id, slug: projects.slug }).from(projects),
  ]);

  const slugOf = new Map(projectRows.map((row) => [row.id, row.slug]));
  const history = new Map<number, FormatRow[]>();
  for (const row of rows) {
    const list = history.get(row.projectId) ?? [];
    list.push(row);
    history.set(row.projectId, list);
  }

  const holds: Hold[] = [];
  for (const [projectId, list] of history) {
    const slug = slugOf.get(projectId);
    if (slug !== undefined) holds.push(...holdsOf(slug, list));
  }
  return holds;
}
