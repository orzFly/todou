/**
 * The one place that respells a moved card's content and writes it back
 * (T-247), shared by the move's copy pass and the `refs backfill` command
 * that owes the same rewrite to cards moved before it existed.
 *
 * Everything the grammar needs is assembled by the caller before any
 * transaction opens: the anchors come out of the system database and the
 * owners' own project databases, and a project transaction has no business
 * holding a second connection for either.
 */

import type {
  AgentContext,
  IssueMove,
  RespellInputs,
  ScanConfig,
} from "@todou/shared";
import {
  maskMarkdownCode,
  ownerAt,
  respellForMove,
  scanReferenceTokens,
} from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issues, specVersionFiles } from "../db/project-schema.ts";
import { projects } from "../db/system-schema.ts";
import { type ProjectRow, routeInfoOf } from "./access.ts";
import {
  loadReferenceInputs,
  type ReferenceInputs,
} from "./cross-references.ts";
import { refPrefixAt } from "./references.ts";
import { recordRevision } from "./revisions.ts";
import { utf8Size } from "./spec.ts";

/**
 * A piece of content with its anchor resolved, still waiting for the comment
 * id map — which the move only knows once its copy has landed.
 */
export type AnchoredText = {
  text: string;
  anchor: ScanConfig;
  originSlug: string;
  foreignCommentIssue: ReadonlyMap<number, number>;
};

export function inputsOf(
  content: AnchoredText,
  commentIdMap: ReadonlyMap<number, number>,
): RespellInputs {
  return {
    anchor: content.anchor,
    originSlug: content.originSlug,
    commentIdMap,
    foreignCommentIssue: content.foreignCommentIssue,
  };
}

/** One rewritable piece of a card, already paired with the row that holds it. */
export type PreparedSegment = {
  subject:
    | { kind: "issue_body"; issueId: number }
    | { kind: "comment"; commentId: number }
    | { kind: "spec_file"; fileId: number };
  text: string;
  inputs: RespellInputs;
  /**
   * Whose revision this is. Per segment because the backfill has no session
   * user to sign with and borrows the mover's, which differs per interval when
   * a card has changed hands more than once.
   */
  actorId: number;
};

export type RespellReport = {
  changed: number;
  skipped: number;
  /** Tokens respelled across every segment; what `--dry-run` reports. */
  rewritten: number;
};

/**
 * Everything one owner project contributes to an anchor. Held per owner
 * rather than per segment because a card that has moved twice needs the
 * format history of every project it has lived in, and each of those may sit
 * in a different database.
 */
export type OwnerAnchor = {
  projectId: number;
  /** The owner's CURRENT canonical slug: what the qualified form is spelled with. */
  slug: string;
  db: Db;
  inputs: ReferenceInputs;
};

/**
 * The anchor projects a card's moves name, minus the one it ends up in.
 *
 * An owner whose project is gone is absent from the map, which reads as "this
 * interval cannot be anchored" — the same call the reference extractor makes
 * when `ownerAt` comes back null.
 */
export async function ownerAnchorsOf(
  ctx: DbContext,
  moves: readonly IssueMove[],
  currentProjectId: number,
): Promise<Map<number, OwnerAnchor>> {
  const wanted = new Set<number>();
  for (const move of moves) {
    if (
      move.from_project_id !== null &&
      move.from_project_id !== currentProjectId
    ) {
      wanted.add(move.from_project_id);
    }
  }
  const anchors = new Map<number, OwnerAnchor>();
  if (wanted.size === 0) return anchors;

  const rows = await ctx.router
    .system()
    .select()
    .from(projects)
    .where(inArray(projects.id, [...wanted]));
  for (const row of rows as ProjectRow[]) {
    const db = await ctx.router.forProject(routeInfoOf(row));
    anchors.set(row.id, {
      projectId: row.id,
      slug: row.slug,
      db,
      inputs: await loadReferenceInputs(ctx, db, row.id),
    });
  }
  return anchors;
}

/**
 * The grammar as it stood for `owner` at `at`.
 *
 * `refPrefixAt` is asked per distinct instant rather than derived from a
 * history read once: the ordering rule for two format rows sharing a
 * timestamp lives in that query, and a second copy of it here is a rule that
 * can drift.
 */
export async function anchorAt(
  owner: OwnerAnchor,
  at: Date,
): Promise<ScanConfig> {
  return {
    internalPrefix: await refPrefixAt(owner.db, owner.projectId, at),
    autolinks: owner.inputs.autolinks,
    cross: {
      slugs: owner.inputs.slugs,
      directory: owner.inputs.directory,
      slugEntries: owner.inputs.slugEntries,
      at: at.toISOString(),
    },
  };
}

/**
 * The owner an instant belongs to, or null when there is nothing to respell:
 * content the card wrote at its current address is already spelled for it,
 * and an owner nobody can resolve is the residual gap the web's origin
 * machinery still covers.
 */
export function anchorOwnerAt(
  anchors: ReadonlyMap<number, OwnerAnchor>,
  moves: readonly IssueMove[],
  currentProjectId: number,
  at: Date,
): { owner: OwnerAnchor | null; unanchored: boolean } {
  const ownerId = ownerAt(moves, currentProjectId, at.toISOString());
  if (ownerId === null) return { owner: null, unanchored: true };
  if (ownerId === currentProjectId) return { owner: null, unanchored: false };
  const owner = anchors.get(ownerId);
  return owner === undefined
    ? { owner: null, unanchored: true }
    : { owner, unanchored: false };
}

/** The comment ids a text names under its own anchor, code regions excluded. */
function commentIdsIn(text: string, anchor: ScanConfig): number[] {
  const ids: number[] = [];
  for (const token of scanReferenceTokens(maskMarkdownCode(text), anchor)) {
    if (token.type === "comment") ids.push(token.commentId);
  }
  return ids;
}

/** A segment far enough along to say which comment ids it names. */
export type Anchored = {
  text: string;
  owner: OwnerAnchor;
  anchor: ScanConfig;
};

/**
 * Where every comment id these segments name lives, one query per owner
 * project rather than per segment: a card with a hundred comments asks the
 * same question over and over, and the answer belongs to the project.
 */
export async function commentCardsPerOwner(
  segments: readonly Anchored[],
): Promise<Map<number, Map<number, number>>> {
  const wanted = new Map<number, { owner: OwnerAnchor; ids: Set<number> }>();
  for (const segment of segments) {
    const entry = wanted.get(segment.owner.projectId) ?? {
      owner: segment.owner,
      ids: new Set<number>(),
    };
    for (const id of commentIdsIn(segment.text, segment.anchor)) {
      entry.ids.add(id);
    }
    wanted.set(segment.owner.projectId, entry);
  }
  const cards = new Map<number, Map<number, number>>();
  for (const [projectId, entry] of wanted) {
    cards.set(
      projectId,
      await commentCardsOf(entry.owner.db, projectId, [...entry.ids]),
    );
  }
  return cards;
}

/**
 * Which card each comment id lives on, in the project that owned the text.
 *
 * Deliberately not gated on `referenceable`: this answers where an id lives
 * so the spelling can keep pointing there, and a card in the trash is still
 * where its comments are. Whether a reference to it gets recorded stays the
 * extractor's decision, unchanged.
 */
export async function commentCardsOf(
  db: Db,
  projectId: number,
  ids: readonly number[],
): Promise<Map<number, number>> {
  const cards = new Map<number, number>();
  if (ids.length === 0) return cards;
  const rows = await db
    .select({ id: comments.id, number: issues.number })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(
      and(eq(comments.projectId, projectId), inArray(comments.id, [...ids])),
    );
  for (const row of rows) cards.set(row.id, row.number);
  return cards;
}

/**
 * Respell every prepared segment and write the ones that changed.
 *
 * A rewritten body or comment records a revision holding the text as its
 * author typed it, and deliberately leaves `edited_at`/`body_edited_at`
 * alone: the "(edited)" mark means the author changed their words, which a
 * spelling normalisation must not claim to have done. Spec files record
 * nothing — a spec version IS its own history.
 *
 * `dryRun` still respells everything, so the count it reports is the count
 * the real run will produce rather than an estimate of it.
 */
export async function applyRespell(
  db: Db,
  segments: readonly PreparedSegment[],
  where: {
    projectId: number;
    agentContext: AgentContext | null;
    dryRun?: boolean;
  },
): Promise<RespellReport> {
  const report: RespellReport = { changed: 0, skipped: 0, rewritten: 0 };
  for (const segment of segments) {
    const result = respellForMove(segment.text, segment.inputs);
    if (result.skipped) report.skipped += 1;
    if (!result.changed) continue;
    report.changed += 1;
    report.rewritten += result.rewritten;
    if (where.dryRun === true) continue;
    const revision = (
      subjectType: "issue_body" | "comment",
      subjectId: number,
    ) =>
      recordRevision(db, {
        projectId: where.projectId,
        subjectType,
        subjectId,
        body: segment.text,
        actorId: segment.actorId,
        agentContext: where.agentContext,
      });

    switch (segment.subject.kind) {
      case "issue_body": {
        const { issueId } = segment.subject;
        await db
          .update(issues)
          .set({ body: result.text })
          .where(eq(issues.id, issueId));
        await revision("issue_body", issueId);
        break;
      }
      case "comment": {
        const { commentId } = segment.subject;
        await db
          .update(comments)
          .set({ body: result.text })
          .where(eq(comments.id, commentId));
        await revision("comment", commentId);
        break;
      }
      case "spec_file":
        await db
          .update(specVersionFiles)
          .set({ body: result.text, size: utf8Size(result.text) })
          .where(eq(specVersionFiles.id, segment.subject.fileId));
        break;
    }
  }
  return report;
}
