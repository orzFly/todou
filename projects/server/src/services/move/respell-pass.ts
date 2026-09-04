/**
 * The move's second pass over its own copy: the card's text respelled so a
 * bare `#12` written at the old address keeps naming the card it named
 * (T-247).
 *
 * Second pass rather than rewriting as it copies, because `#comment-M` needs
 * the complete old→new comment map, which only exists once the copy is done.
 */

import type { AgentContext, IssueMove, ScanConfig } from "@todou/shared";
import { eq, inArray } from "drizzle-orm";
import type { AppContext } from "../../bootstrap.ts";
import type { Db } from "../../db/driver.ts";
import {
  comments,
  specVersionFiles,
  specVersions,
} from "../../db/project-schema.ts";
import { movedInHistory } from "../relocation.ts";
import {
  type Anchored,
  type AnchoredText,
  anchorAt,
  anchorOwnerAt,
  applyRespell,
  commentCardsPerOwner,
  inputsOf,
  ownerAnchorsOf,
  type PreparedSegment,
  type RespellReport,
} from "../respell-content.ts";
import type { IdMap } from "./copy.ts";
import type { MovePlan } from "./plan.ts";

/**
 * Everything the rewrite needs that a project transaction must not go looking
 * for: the system tier's grammar inputs, every former owner's format history,
 * and the source text itself.
 */
export type RespellAssembly = {
  body: AnchoredText | null;
  comments: Array<{ sourceId: number; content: AnchoredText }>;
  specFiles: Array<{
    versionNumber: number;
    path: string;
    content: AnchoredText;
  }>;
  /** Segments whose owning project is gone, so nothing could be respelled. */
  unanchored: number;
};

type Draft<Key> = Anchored & { key: Key };

/** Only markdown travels through the respell; other spec files keep their bytes. */
const isMarkdown = (path: string): boolean =>
  path.toLowerCase().endsWith(".md");

export async function assembleRespell(
  ctx: AppContext,
  plan: MovePlan,
): Promise<RespellAssembly> {
  const target = plan.target.project.id;
  const moves: IssueMove[] = [
    ...(await movedInHistory(plan.source.db, plan.row.id)),
    {
      at: plan.movedAt.toISOString(),
      from_project_id: plan.source.project.id,
      from_project: plan.source.project.slug,
      from_number: plan.row.number,
    },
  ];
  const anchors = await ownerAnchorsOf(ctx, moves, target);

  const commentRows = await plan.source.db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(eq(comments.issueId, plan.row.id))
    .orderBy(comments.id);
  const versionRows = await plan.source.db
    .select({
      id: specVersions.id,
      number: specVersions.number,
      createdAt: specVersions.createdAt,
    })
    .from(specVersions)
    .where(eq(specVersions.issueId, plan.row.id));
  const fileRows =
    versionRows.length === 0
      ? []
      : await plan.source.db
          .select({
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
  const versionById = new Map(versionRows.map((row) => [row.id, row]));

  let unanchored = 0;
  const memo = new Map<string, ScanConfig>();
  const draft = async <Key>(
    key: Key,
    text: string,
    at: Date,
  ): Promise<Draft<Key> | null> => {
    const resolved = anchorOwnerAt(anchors, moves, target, at);
    if (resolved.unanchored) unanchored += 1;
    if (resolved.owner === null) return null;
    const memoKey = `${resolved.owner.projectId}:${at.getTime()}`;
    let anchor = memo.get(memoKey);
    if (anchor === undefined) {
      anchor = await anchorAt(resolved.owner, at);
      memo.set(memoKey, anchor);
    }
    return { key, text, owner: resolved.owner, anchor };
  };

  const bodyDraft = await draft(null, plan.row.body, plan.row.createdAt);
  const commentDrafts: Array<Draft<number>> = [];
  for (const row of commentRows) {
    const one = await draft(row.id, row.body, row.createdAt);
    if (one !== null) commentDrafts.push(one);
  }
  const fileDrafts: Array<Draft<{ versionNumber: number; path: string }>> = [];
  for (const row of fileRows) {
    const version = versionById.get(row.versionId);
    if (version === undefined || !isMarkdown(row.path)) continue;
    const one = await draft(
      { versionNumber: version.number, path: row.path },
      row.body,
      version.createdAt,
    );
    if (one !== null) fileDrafts.push(one);
  }

  const cards = await commentCardsPerOwner([
    ...(bodyDraft === null ? [] : [bodyDraft]),
    ...commentDrafts,
    ...fileDrafts,
  ]);
  const anchored = <Key>(one: Draft<Key>): AnchoredText => ({
    text: one.text,
    anchor: one.anchor,
    originSlug: one.owner.slug,
    foreignCommentIssue: cards.get(one.owner.projectId) ?? new Map(),
  });

  return {
    body: bodyDraft === null ? null : anchored(bodyDraft),
    comments: commentDrafts.map((one) => ({
      sourceId: one.key,
      content: anchored(one),
    })),
    specFiles: fileDrafts.map((one) => ({
      versionNumber: one.key.versionNumber,
      path: one.key.path,
      content: anchored(one),
    })),
    unanchored,
  };
}

/**
 * Apply the assembled rewrite to the copy that just landed, in the same
 * transaction — a card must never be readable half respelled.
 */
export async function respellCopiedContent(
  tx: Db,
  plan: MovePlan,
  assembly: RespellAssembly,
  idMap: IdMap,
  actor: { actorId: number; agentContext: AgentContext | null },
): Promise<RespellReport> {
  const segments: PreparedSegment[] = [];
  if (assembly.body !== null) {
    segments.push({
      subject: { kind: "issue_body", issueId: idMap.issueId },
      text: assembly.body.text,
      inputs: inputsOf(assembly.body, idMap.comments),
      actorId: actor.actorId,
    });
  }
  for (const one of assembly.comments) {
    const landed = idMap.comments.get(one.sourceId);
    if (landed === undefined) continue;
    segments.push({
      subject: { kind: "comment", commentId: landed },
      text: one.content.text,
      inputs: inputsOf(one.content, idMap.comments),
      actorId: actor.actorId,
    });
  }
  if (assembly.specFiles.length > 0) {
    const files = await landedSpecFiles(tx, idMap.issueId);
    for (const one of assembly.specFiles) {
      const fileId = files.get(`${one.versionNumber} ${one.path}`);
      if (fileId === undefined) continue;
      segments.push({
        subject: { kind: "spec_file", fileId },
        text: one.content.text,
        inputs: inputsOf(one.content, idMap.comments),
        actorId: actor.actorId,
      });
    }
  }

  const report = await applyRespell(tx, segments, {
    projectId: plan.target.project.id,
    agentContext: actor.agentContext,
  });
  if (report.skipped > 0 || assembly.unanchored > 0) {
    console.warn(
      `respell: ${plan.source.project.slug}/${plan.row.number} left ` +
        `${report.skipped} segment(s) unrespelled and ${assembly.unanchored} ` +
        "unanchored",
    );
  }
  return report;
}

/**
 * The copied spec files by version number and path — the pairing the copy
 * preserves, which is why the id map needs no third dimension.
 */
async function landedSpecFiles(
  tx: Db,
  issueId: number,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      id: specVersionFiles.id,
      path: specVersionFiles.path,
      number: specVersions.number,
    })
    .from(specVersionFiles)
    .innerJoin(specVersions, eq(specVersionFiles.versionId, specVersions.id))
    .where(eq(specVersions.issueId, issueId));
  return new Map(rows.map((row) => [`${row.number} ${row.path}`, row.id]));
}
