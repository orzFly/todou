/**
 * The one-off rewrite that moves every stored reference onto the new form
 * (T-266): from a token read at display time to an explicit link anchored on
 * a project id.
 *
 * An operator runs this once, after the deploy that ships the resolve pass.
 * Its input is the reading rule it retires — a segment of text means what it
 * meant to whoever wrote it, under the project that owned the card then and
 * the spellings in force at that instant — which is precisely why the
 * machinery for that rule has to survive until this has run.
 *
 * A second run finds nothing to do, which is what makes a real run after a
 * `--dry-run` safe.
 */

import type { ScanConfig } from "@todou/shared";
import { ownerAt } from "@todou/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issues,
  specVersionFiles,
  specVersions,
} from "../db/project-schema.ts";
import { projects, slugHistory } from "../db/system-schema.ts";
import { type ProjectRow, routeInfoOf } from "./access.ts";
import {
  loadReferenceInputs,
  type ReferenceInputs,
} from "./cross-references.ts";
import { refPrefixAt } from "./references.ts";
import { movedInHistory } from "./relocation.ts";
import { resolveText } from "./resolve-pass.ts";
import { recordRevision } from "./revisions.ts";
import { utf8Size } from "./spec.ts";

export type MigrateReport = {
  projects: number;
  issues: number;
  segments: number;
  /** Segments whose text changed. */
  changed: number;
  /** References turned into links. */
  links: number;
  /** Candidates left exactly as written. */
  unresolved: number;
  /** Events given an id, or given the merged type. */
  events: number;
};

export type MigrateOptions = {
  dryRun: boolean;
  /** One project only; the whole deployment when absent. */
  slug?: string;
  /** How many distinct unresolved spellings to name in the report. */
  sample?: number;
  log: (line: string) => void;
};

/** A spelling the resolver turned down, and where an operator can see it. */
type Unresolved = { count: number; at: string };

/** A project a segment may have been written in, with its grammar loaded. */
type Anchor = {
  project: ProjectRow;
  db: Db;
  inputs: ReferenceInputs;
};

class MigrationStopped extends Error {}

export async function migrateRefs(
  ctx: DbContext,
  opts: MigrateOptions,
): Promise<MigrateReport> {
  const report: MigrateReport = {
    projects: 0,
    issues: 0,
    segments: 0,
    changed: 0,
    links: 0,
    unresolved: 0,
    events: 0,
  };
  const system = ctx.router.system();

  await assertNoNumericSlugs(system, opts);

  const rows =
    opts.slug === undefined
      ? await system.select().from(projects)
      : await system
          .select()
          .from(projects)
          .where(eq(projects.slug, opts.slug));

  const anchors = new Map<number, Anchor>();
  const anchorOf = async (project: ProjectRow): Promise<Anchor> => {
    const known = anchors.get(project.id);
    if (known !== undefined) return known;
    const db = await ctx.router.forProject(routeInfoOf(project));
    const anchor: Anchor = {
      project,
      db,
      inputs: await loadReferenceInputs(ctx, db, project.id),
    };
    anchors.set(project.id, anchor);
    return anchor;
  };
  const projectById = async (id: number): Promise<ProjectRow | null> => {
    const known = anchors.get(id);
    if (known !== undefined) return known.project;
    const found = await system
      .select()
      .from(projects)
      .where(eq(projects.id, id));
    return found[0] ?? null;
  };

  const holders = await slugHolders(system);
  const unresolved = new Map<string, Unresolved>();
  for (const project of rows as ProjectRow[]) {
    report.projects += 1;
    const home = await anchorOf(project);
    for (const issueId of await issueIdsOf(home.db, project.id)) {
      const one = await migrateIssue(
        ctx,
        home,
        issueId,
        { anchorOf, projectById },
        unresolved,
        opts,
      );
      if (one === null) continue;
      report.issues += 1;
      report.segments += one.segments;
      report.changed += one.changed;
      report.links += one.links;
      report.unresolved += one.unresolved;
      if (one.changed > 0) {
        opts.log(
          `${project.slug}/${one.number}: ${one.changed} segment(s), ` +
            `${one.links} link(s)`,
        );
      }
    }
    report.events += await migrateEvents(home, holders, opts);
  }

  if (unresolved.size > 0) {
    const sample = opts.sample ?? 20;
    opts.log(`left verbatim (${unresolved.size} distinct spelling(s)):`);
    for (const [text, seen] of [...unresolved.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, sample)) {
      opts.log(`  ${seen.count}× ${text} (first at ${seen.at})`);
    }
  }
  return report;
}

/**
 * The check that makes an all-digit path segment mean one thing.
 *
 * New slugs cannot be all digits, but a deployment predating that rule may
 * hold one, and `/projects/12/` would then name both a project id and that
 * project. Renaming somebody's project is not this command's call, so it
 * stops and says which ones.
 */
async function assertNoNumericSlugs(
  system: Db,
  opts: MigrateOptions,
): Promise<void> {
  const rows = await system
    .select({ slug: projects.slug })
    .from(projects)
    .where(sql`${projects.slug} ~ '^[0-9]+$'`);
  if (rows.length === 0) return;
  const names = rows.map((row) => row.slug).join(", ");
  opts.log(
    `refusing to migrate: these project slugs are all digits and would be ` +
      `read as project ids — rename them first: ${names}`,
  );
  throw new MigrationStopped(`all-digit project slug(s): ${names}`);
}

export function isMigrationStopped(error: unknown): boolean {
  return error instanceof MigrationStopped;
}

async function issueIdsOf(db: Db, projectId: number): Promise<number[]> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.projectId, projectId))
    .orderBy(issues.id);
  return rows.map((row) => row.id);
}

type Segment = {
  subject:
    | { kind: "issue_body"; issueId: number }
    | { kind: "comment"; commentId: number }
    | { kind: "spec_file"; fileId: number };
  text: string;
  /** When it was written, which decides whose numbering it used. */
  at: Date;
  /** Who to attribute the revision to: whoever moved the card into its era. */
  actorId: number;
};

type IssueMigration = {
  number: number;
  segments: number;
  changed: number;
  links: number;
  unresolved: number;
};

async function migrateIssue(
  ctx: DbContext,
  home: Anchor,
  issueId: number,
  lookup: {
    anchorOf: (project: ProjectRow) => Promise<Anchor>;
    projectById: (id: number) => Promise<ProjectRow | null>;
  },
  unresolved: Map<string, Unresolved>,
  opts: MigrateOptions,
): Promise<IssueMigration | null> {
  const db = home.db;
  const [issueRow] = await db
    .select({
      number: issues.number,
      body: issues.body,
      createdAt: issues.createdAt,
      authorId: issues.authorId,
    })
    .from(issues)
    .where(eq(issues.id, issueId));
  if (issueRow === undefined) return null;

  const moves = await movedInHistory(db, issueId);
  const commentRows = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      authorId: comments.authorId,
    })
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(comments.id);
  const versionRows = await db
    .select({ id: specVersions.id, createdAt: specVersions.createdAt })
    .from(specVersions)
    .where(eq(specVersions.issueId, issueId));
  const fileRows =
    versionRows.length === 0
      ? []
      : await db
          .select({
            id: specVersionFiles.id,
            versionId: specVersionFiles.versionId,
            body: specVersionFiles.body,
          })
          .from(specVersionFiles)
          .where(
            inArray(
              specVersionFiles.versionId,
              versionRows.map((row) => row.id),
            ),
          );
  const versionAt = new Map(versionRows.map((row) => [row.id, row.createdAt]));

  const segments: Segment[] = [
    {
      subject: { kind: "issue_body", issueId },
      text: issueRow.body,
      at: issueRow.createdAt,
      actorId: issueRow.authorId,
    },
    ...commentRows.map((row) => ({
      subject: { kind: "comment" as const, commentId: row.id },
      text: row.body,
      at: row.createdAt,
      actorId: row.authorId,
    })),
  ];
  for (const row of fileRows) {
    const at = versionAt.get(row.versionId);
    if (at === undefined) continue;
    segments.push({
      subject: { kind: "spec_file", fileId: row.id },
      text: row.body,
      at,
      actorId: issueRow.authorId,
    });
  }

  const writes: Array<{ segment: Segment; text: string }> = [];
  const result: IssueMigration = {
    number: issueRow.number,
    segments: 0,
    changed: 0,
    links: 0,
    unresolved: 0,
  };

  for (const segment of segments) {
    if (segment.text === "") continue;
    result.segments += 1;
    // Whose numbering this segment used. `ownerAt` reads the card's arrivals;
    // an owner that no longer exists leaves the segment unanchored, and an
    // unanchored segment is left alone rather than read under the wrong
    // project — the same call the retired extractor made.
    const ownerId = ownerAt(moves, home.project.id, segment.at.toISOString());
    if (ownerId === null) continue;
    let anchor = home;
    if (ownerId !== home.project.id) {
      const owner = await lookup.projectById(ownerId);
      if (owner === null) continue;
      anchor = await lookup.anchorOf(owner);
    }

    const resolved = await resolveText(
      {
        ctx,
        here: anchor.project,
        hereDb: anchor.db,
        // No author to ask about, and nothing to protect: the text already
        // names its target in the clear, and an id says less than a slug.
        mayRead: async () => true,
        gate: "exists",
      },
      segment.text,
      await anchorConfigAt(anchor, segment.at),
    );
    for (const spelling of resolved.unresolved) {
      const seen = unresolved.get(spelling);
      if (seen === undefined) {
        unresolved.set(spelling, {
          count: 1,
          at: `${home.project.slug}/${issueRow.number}`,
        });
      } else {
        seen.count += 1;
      }
      result.unresolved += 1;
    }
    if (resolved.storedText === segment.text) continue;
    result.changed += 1;
    result.links += countLinksAdded(segment.text, resolved.storedText);
    writes.push({ segment, text: resolved.storedText });
  }

  if (writes.length === 0 || opts.dryRun) return result;
  // One transaction per card: a card is never readable half migrated, and a
  // failure on one leaves the rest of the walk usable.
  await db.transaction(async (tx) => {
    for (const write of writes) await applyWrite(tx, home.project.id, write);
  });
  return result;
}

/** The grammar as this project's numbering stood at `at`. */
async function anchorConfigAt(anchor: Anchor, at: Date): Promise<ScanConfig> {
  return {
    internalPrefix: await refPrefixAt(anchor.db, anchor.project.id, at),
    autolinks: anchor.inputs.autolinks,
    cross: {
      slugs: anchor.inputs.slugs,
      directory: anchor.inputs.directory,
      slugEntries: anchor.inputs.slugEntries,
      at: at.toISOString(),
    },
  };
}

function countLinksAdded(before: string, after: string): number {
  const count = (text: string) =>
    (text.match(/]\(\/(?:api\/)?projects\//g) ?? []).length;
  return Math.max(count(after) - count(before), 0);
}

/**
 * A rewritten body or comment records a revision holding the text as its
 * author typed it, and deliberately leaves `edited_at`/`body_edited_at`
 * alone: the "(edited)" mark means the author changed their words, which
 * resolving a reference must not claim to have done. Spec files record
 * nothing — a spec version IS its own history (T-247 review #2361).
 */
async function applyWrite(
  tx: Db,
  projectId: number,
  write: { segment: Segment; text: string },
): Promise<void> {
  const { segment, text } = write;
  switch (segment.subject.kind) {
    case "issue_body": {
      const { issueId } = segment.subject;
      await tx.update(issues).set({ body: text }).where(eq(issues.id, issueId));
      await recordRevision(tx, {
        projectId,
        subjectType: "issue_body",
        subjectId: issueId,
        body: segment.text,
        actorId: segment.actorId,
        agentContext: null,
      });
      break;
    }
    case "comment": {
      const { commentId } = segment.subject;
      await tx
        .update(comments)
        .set({ body: text })
        .where(eq(comments.id, commentId));
      await recordRevision(tx, {
        projectId,
        subjectType: "comment",
        subjectId: commentId,
        body: segment.text,
        actorId: segment.actorId,
        agentContext: null,
      });
      break;
    }
    case "spec_file":
      await tx
        .update(specVersionFiles)
        .set({ body: text, size: utf8Size(text) })
        .where(eq(specVersionFiles.id, segment.subject.fileId));
      break;
  }
}

/**
 * Bring the reference events onto the merged shape: one type, and a project
 * id rather than a slug.
 *
 * A `referenced` row was local by definition, so the project it names is the
 * one it lives in. A `cross_referenced` row usually carries the id already
 * (T-231); the ones that do not predate it and carry only a slug, which has
 * to be read as of the event's own instant — a slug that has since changed
 * hands would otherwise hand the event to its new holder.
 *
 * The old keys stay in the jsonb. Nothing reads them once this has run, and
 * leaving them costs nothing while making a rollback a matter of reverting
 * the code.
 */
async function migrateEvents(
  home: Anchor,
  holders: SlugHolders,
  opts: MigrateOptions,
): Promise<number> {
  const projectId = home.project.id;
  const rows = await home.db
    .select({
      id: issueEvents.id,
      type: issueEvents.type,
      payload: issueEvents.payload,
      createdAt: issueEvents.createdAt,
    })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.projectId, projectId),
        inArray(issueEvents.type, ["referenced", "cross_referenced"]),
      ),
    );
  if (rows.length === 0) return 0;

  let touched = 0;
  const writes: Array<{ id: number; payload: Record<string, unknown> }> = [];
  for (const row of rows) {
    const payload = { ...(row.payload as Record<string, unknown>) };
    const alreadyMerged =
      row.type === "referenced" && typeof payload.by_project_id === "number";
    if (alreadyMerged) continue;

    if (typeof payload.by_project_id !== "number") {
      const far =
        row.type === "referenced"
          ? projectId
          : typeof payload.by_project === "string"
            ? holders(payload.by_project, row.createdAt)
            : null;
      // Nothing to say who wrote it, so the row keeps its old shape and the
      // renderer's fallback keeps showing it. Better a stale slug than an id
      // pointing at whoever holds that name today.
      if (far === null) continue;
      payload.by_project_id = far;
    }
    writes.push({ id: row.id, payload });
  }

  if (writes.length === 0) return 0;
  touched = writes.length;
  if (opts.dryRun) return touched;
  await home.db.transaction(async (tx) => {
    for (const write of writes) {
      await tx
        .update(issueEvents)
        .set({ type: "referenced", payload: write.payload })
        .where(eq(issueEvents.id, write.id));
    }
  });
  return touched;
}

/** Which project held a slug at an instant. */
type SlugHolders = (slug: string, at: Date) => number | null;

/** Read once per walk: every event of every project asks the same question. */
async function slugHolders(system: Db): Promise<SlugHolders> {
  const rows = await system
    .select({ id: projects.id, slug: projects.slug })
    .from(projects);
  const history = await system
    .select({
      projectId: slugHistory.projectId,
      slug: slugHistory.slug,
      from: slugHistory.effectiveFrom,
    })
    .from(slugHistory);

  const byId = new Map(rows.map((row) => [row.id, row.slug]));
  const claims = new Map<string, Array<{ projectId: number; from: Date }>>();
  for (const row of history) {
    const list = claims.get(row.slug) ?? [];
    list.push({ projectId: row.projectId, from: row.from });
    claims.set(row.slug, list);
  }
  for (const list of claims.values()) {
    list.sort((a, b) => a.from.getTime() - b.from.getTime());
  }

  return (slug, at) => {
    const list = claims.get(slug);
    if (list !== undefined) {
      // The holder is the newest claim not later than `at`.
      let held: number | null = null;
      for (const claim of list) {
        if (claim.from.getTime() <= at.getTime()) held = claim.projectId;
      }
      if (held !== null) return held;
    }
    // No history row: the slug has only ever had its current holder.
    for (const [id, current] of byId) if (current === slug) return id;
    return null;
  };
}
