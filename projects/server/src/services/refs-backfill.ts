/**
 * The respell owed to every card that moved before the move learnt to do it
 * itself (T-247).
 *
 * An operator runs this once after the deploy. A second run finds nothing left
 * to do, which is what makes a real run after a `--dry-run` safe.
 */

import { moveAfter } from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issues,
  specVersionFiles,
  specVersions,
} from "../db/project-schema.ts";
import { projects } from "../db/system-schema.ts";
import { type ProjectRow, routeInfoOf } from "./access.ts";
import { type MoveRecord, movedInHistory } from "./relocation.ts";
import {
  type Anchored,
  anchorAt,
  anchorOwnerAt,
  applyRespell,
  commentCardsPerOwner,
  ownerAnchorsOf,
  type PreparedSegment,
} from "./respell-content.ts";

export type BackfillReport = {
  projects: number;
  issues: number;
  changed: number;
  rewritten: number;
  skipped: number;
  unanchored: number;
};

export type BackfillOptions = {
  dryRun: boolean;
  /** One project only; the whole deployment when absent. */
  slug?: string;
  log: (line: string) => void;
};

export async function backfillRefs(
  ctx: DbContext,
  opts: BackfillOptions,
): Promise<BackfillReport> {
  const report: BackfillReport = {
    projects: 0,
    issues: 0,
    changed: 0,
    rewritten: 0,
    skipped: 0,
    unanchored: 0,
  };
  const system = ctx.router.system();
  const rows =
    opts.slug === undefined
      ? await system.select().from(projects)
      : await system
          .select()
          .from(projects)
          .where(eq(projects.slug, opts.slug));

  for (const project of rows as ProjectRow[]) {
    report.projects += 1;
    const db = await ctx.router.forProject(routeInfoOf(project));
    for (const issueId of await movedCards(db, project.id)) {
      const one = await backfillIssue(ctx, db, project, issueId, opts);
      if (one === null) continue;
      report.issues += 1;
      report.changed += one.changed;
      report.rewritten += one.rewritten;
      report.skipped += one.skipped;
      report.unanchored += one.unanchored;
      if (one.changed > 0 || one.skipped > 0 || one.unanchored > 0) {
        opts.log(
          `${project.slug}/${one.number}: ${one.changed} segment(s), ` +
            `${one.rewritten} reference(s)` +
            (one.skipped > 0 ? `, ${one.skipped} skipped` : "") +
            (one.unanchored > 0 ? `, ${one.unanchored} unanchored` : ""),
        );
      }
    }
  }
  return report;
}

/** The cards that have arrived from somewhere; a tombstone keeps no events. */
async function movedCards(db: Db, projectId: number): Promise<number[]> {
  const rows = await db
    .select({ issueId: issueEvents.issueId })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.projectId, projectId),
        eq(issueEvents.type, "moved_in"),
      ),
    );
  return [...new Set(rows.map((row) => row.issueId))];
}

type IssueBackfill = {
  number: number;
  changed: number;
  rewritten: number;
  skipped: number;
  unanchored: number;
};

async function backfillIssue(
  ctx: DbContext,
  db: Db,
  project: ProjectRow,
  issueId: number,
  opts: BackfillOptions,
): Promise<IssueBackfill | null> {
  const moves = await movedInHistory(db, issueId);
  if (moves.length === 0) return null;
  const [issueRow] = await db
    .select({
      number: issues.number,
      body: issues.body,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(eq(issues.id, issueId));
  if (issueRow === undefined) return null;

  const anchors = await ownerAnchorsOf(ctx, moves, project.id);
  const commentRows = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(comments.id);
  const versionRows = await db
    .select({
      id: specVersions.id,
      createdAt: specVersions.createdAt,
    })
    .from(specVersions)
    .where(eq(specVersions.issueId, issueId));
  const fileRows =
    versionRows.length === 0
      ? []
      : await db
          .select({
            id: specVersionFiles.id,
            versionId: specVersionFiles.versionId,
            path: specVersionFiles.path,
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

  let unanchored = 0;
  const drafts: Array<
    Anchored & { subject: PreparedSegment["subject"]; move: MoveRecord }
  > = [];
  const draft = async (
    subject: PreparedSegment["subject"],
    text: string,
    at: Date,
  ): Promise<void> => {
    const resolved = anchorOwnerAt(anchors, moves, project.id, at);
    if (resolved.unanchored) unanchored += 1;
    const move = moveAfter(moves, at.toISOString());
    if (resolved.owner === null || move === null) return;
    drafts.push({
      subject,
      text,
      move,
      owner: resolved.owner,
      anchor: await anchorAt(resolved.owner, at),
    });
  };

  await draft(
    { kind: "issue_body", issueId },
    issueRow.body,
    issueRow.createdAt,
  );
  for (const row of commentRows) {
    await draft(
      { kind: "comment", commentId: row.id },
      row.body,
      row.createdAt,
    );
  }
  for (const row of fileRows) {
    const at = versionAt.get(row.versionId);
    if (at === undefined || !row.path.toLowerCase().endsWith(".md")) continue;
    await draft({ kind: "spec_file", fileId: row.id }, row.body, at);
  }
  if (drafts.length === 0) {
    return {
      number: issueRow.number,
      changed: 0,
      rewritten: 0,
      skipped: 0,
      unanchored,
    };
  }

  const cards = await commentCardsPerOwner(drafts);
  const segments: PreparedSegment[] = drafts.map((one) => ({
    subject: one.subject,
    text: one.text,
    actorId: one.move.actorId,
    inputs: {
      anchor: one.anchor,
      originSlug: one.owner.slug,
      foreignCommentIssue: ownAnchorsOf(
        one.move,
        cards.get(one.owner.projectId),
      ),
    },
  }));

  const where = {
    projectId: project.id,
    agentContext: null,
    dryRun: opts.dryRun,
  };
  const applied = opts.dryRun
    ? await applyRespell(db, segments, where)
    : // One transaction per card: a card is never readable half respelled,
      // and a failure on one card leaves the rest of the walk usable.
      await db.transaction((tx) => applyRespell(tx, segments, where));
  return { number: issueRow.number, ...applied, unanchored };
}

/**
 * The comment anchors this segment may name, its own card's included — as the
 * old address `origin#oldNumber#comment-oldId` rather than as the id the
 * comment carries today.
 *
 * The move writes the new id, which reads better and is safe because it runs
 * exactly once. This walk has no such promise: a bare id says nothing about
 * which address numbered it, and every project database numbers comments from
 * its own sequence, so a second run would happily renumber an id it had
 * already fixed. The old address is a spelling no later pass touches, and the
 * `moved_ids` aliases keep it resolving.
 */
function ownAnchorsOf(
  move: MoveRecord,
  foreign: ReadonlyMap<number, number> | undefined,
): Map<number, number> {
  const anchors = new Map(foreign ?? []);
  if (move.from_number === null) return anchors;
  for (const oldId of move.commentIdMap.keys()) {
    anchors.set(oldId, move.from_number);
  }
  return anchors;
}
