import { type AlignGroup, alignGroups } from "./group-align.ts";
import type {
  Decorations,
  DeletionDecoration,
  SpanDecoration,
} from "./rehype-decorations.ts";
import { changedBlockPairs, type LineRange } from "./spec-changes.ts";
import {
  blocksFullyInLines,
  blocksWhollyInGroups,
  offsetAt,
  outermostBlockOfGroup,
  type SegmentIndex,
  type SourceBlock,
  type SourceRange,
  segmentsInLines,
  sourceOffsetOfText,
  sourceRangesOfText,
  subtractRanges,
  textRangeOf,
  textRangesOfBlocks,
} from "./spec-source-index.ts";
import { wordDiff } from "./word-diff.ts";

/** An annotation as the document sees it: which slice of source it covers. */
export type AnchoredAnnotation = {
  key: string;
  kind: "comment" | "draft";
  start: number;
  end: number;
  colStart: number | null;
  colEnd: number | null;
};

/** The raw source of a 1-based inclusive line range. */
function linesOf(index: SegmentIndex, start: number, end: number): string {
  const from = index.lineStarts[start - 1];
  if (from === undefined) return "";
  const after = index.lineStarts[end];
  return index.source.slice(
    from,
    after === undefined ? index.source.length : after - 1,
  );
}

/**
 * The leaf blocks a line range touches, one entry per block, in document
 * order. Segments of one group are contiguous in the flattened text, so a
 * group is a slice of it and needs no reassembly.
 */
function alignGroupsOf(index: SegmentIndex, range: LineRange): AlignGroup[] {
  const groups: AlignGroup[] = [];
  for (const segment of segmentsInLines(index, range)) {
    const last = groups.at(-1);
    if (last !== undefined && last.group === segment.group) {
      last.text = index.text.slice(last.at, segment.at + segment.text.length);
      continue;
    }
    groups.push({
      group: segment.group,
      type: index.groupTypes[segment.group] ?? null,
      text: segment.text,
      at: segment.at,
    });
  }
  return groups;
}

/**
 * Word-level diff of two versions, as decorations on the newer one (T-142).
 * The block-level "changed since vN" wash stays where it is and keeps
 * driving the ↑↓ navigation; this is what tells the reader *which words*
 * inside those blocks moved.
 *
 * Which words, though, is only a question worth answering when some of them
 * stayed. A block that is new in its entirety gets one highlight and no
 * inner marks (T-158): a brand-new table sliced into a box per cell says
 * nothing the single box around the table doesn't, and shatters the layout
 * to say it.
 *
 * Which of them stayed is answered per leaf block, not per edit (T-163): a
 * rewrite's two sides are aligned block against block first, and only then
 * are words compared inside each match. A block left without a match is the
 * evidence — it was born, or it went — where before the answer had to be
 * inferred from how far a flat word diff's insertions happened to reach.
 */
export function changeDecorations(
  baseline: SegmentIndex,
  current: SegmentIndex,
): Decorations {
  const spans: SpanDecoration[] = [];
  const deletions: DeletionDecoration[] = [];
  const blocks: SourceRange[] = [];

  const insert = (from: number, to: number) => {
    for (const range of sourceRangesOfText(current, from, to)) {
      spans.push({ kind: "ins", start: range.start, end: range.end });
    }
  };

  /** Take the whole blocks, then word-mark only what they left over. */
  const absorb = (inserted: SourceRange[], whole: SourceBlock[]) => {
    for (const block of whole) {
      blocks.push({ start: block.start, end: block.end });
    }
    for (const range of subtractRanges(
      inserted,
      textRangesOfBlocks(current, whole),
    )) {
      insert(range.start, range.end);
    }
  };

  for (const pair of changedBlockPairs(baseline.source, current.source)) {
    if (pair.new === null) {
      if (pair.old === null) continue;
      const gone = linesOf(baseline, pair.old.start, pair.old.end);
      if (gone.trim() === "") continue;
      deletions.push({
        at: offsetAt(current, pair.at, 1) ?? current.source.length,
        text: gone,
        block: true,
      });
      continue;
    }
    const after = textRangeOf(segmentsInLines(current, pair.new));
    const oldGroups =
      pair.old === null ? [] : alignGroupsOf(baseline, pair.old);

    // Nothing on the old side to diff against — either a pure insertion, or
    // a rewrite of lines that held no prose at all (a fence, a table rule).
    // Every line here is new, so line evidence decides, and it is the only
    // evidence a code block will ever get.
    if (oldGroups.length === 0) {
      const whole = blocksFullyInLines(current, pair.new);
      absorb(after === null ? [] : [after], whole);
      continue;
    }
    // Lines with no prose at all carry no inline decoration; their block
    // keeps the plain "changed" highlight.
    if (after === null) continue;

    // Align the two sides block by block before diffing any words (T-163).
    // A rewrite pair can hold a paragraph on one side and a table on the
    // other; one flat word diff across all of it matches prose into blocks
    // that never held it, which both keeps word boxes inside a block that is
    // new in its entirety and strikes the old text through a cell it never
    // lived in.
    const newGroups = alignGroupsOf(current, pair.new);
    const alignment = alignGroups(oldGroups, newGroups);

    for (const matched of alignment.pairs) {
      const result = wordDiff(matched.old.text, matched.new.text);
      for (const range of result.ins) {
        insert(matched.new.at + range.start, matched.new.at + range.end);
      }
      for (const gone of result.del) {
        const text = matched.old.text.slice(gone.from, gone.to);
        if (text.trim() === "") continue;
        const at = sourceOffsetOfText(current, matched.new.at + gone.at);
        if (at === null) continue;
        // Always inline: the pair is one leaf block against one leaf block,
        // so whatever went — a word or the block's whole contents — the
        // block that replaced it is standing right there to carry the
        // strike-through (T-158's ruling for a rewritten table cell).
        deletions.push({ at, text: text.trim(), block: false });
      }
    }

    const born = new Set(alignment.newOnly.map((group) => group.group));
    const whole = blocksWhollyInGroups(current, born);
    const absorbed = new Set<number>();
    for (const block of whole) {
      blocks.push({ start: block.start, end: block.end });
      for (let g = block.firstGroup; g <= block.lastGroup; g++) {
        absorbed.add(g);
      }
    }
    for (const group of alignment.newOnly) {
      if (absorbed.has(group.group)) continue;
      insert(group.at, group.at + group.text.length);
    }

    // Old blocks with no counterpart have nowhere to be struck through, so
    // they degrade to a marker at the seam. Neighbours with nothing new
    // between them share one.
    for (const cluster of clusterDeletions(alignment.oldOnly)) {
      const text = cluster.texts.join("\n").trim();
      if (text === "") continue;
      deletions.push({
        at: seamAt(current, newGroups, cluster.newIndex, pair.at),
        text,
        block: true,
      });
    }
  }
  return { spans, deletions, blocks };
}

/** Unmatched old blocks that sit at the same seam, merged into one marker. */
function clusterDeletions(
  oldOnly: Array<{ group: AlignGroup; newIndex: number }>,
): Array<{ newIndex: number; texts: string[] }> {
  const clusters: Array<{ newIndex: number; texts: string[] }> = [];
  for (const entry of oldOnly) {
    const last = clusters.at(-1);
    if (last !== undefined && last.newIndex === entry.newIndex) {
      last.texts.push(entry.group.text);
    } else
      clusters.push({ newIndex: entry.newIndex, texts: [entry.group.text] });
  }
  return clusters;
}

/**
 * Where a structural marker goes, in the new document's coordinates. The
 * rehype pass splices these between top-level elements, so the answer has to
 * be a top-level seam: the start of the outermost block that follows the
 * deletion, or the end of the one before it when nothing follows.
 */
function seamAt(
  index: SegmentIndex,
  newGroups: AlignGroup[],
  newIndex: number,
  fallbackLine: number,
): number {
  const after = newGroups[newIndex];
  if (after !== undefined) {
    const block = outermostBlockOfGroup(index, after.group);
    if (block !== null) return block.start;
  }
  const before = newGroups[newIndex - 1];
  if (before !== undefined) {
    const block = outermostBlockOfGroup(index, before.group);
    if (block !== null) return block.end;
  }
  return offsetAt(index, fallbackLine, 1) ?? index.source.length;
}

/**
 * Precise highlights for the comments and drafts on this file. Anchors
 * without columns — every anchor taken before T-142, and everything the
 * diff view still produces — get nothing here and keep the whole-block
 * amber they have always had.
 */
export function annotationDecorations(
  index: SegmentIndex,
  annotations: AnchoredAnnotation[],
): SpanDecoration[] {
  const spans: SpanDecoration[] = [];
  for (const annotation of annotations) {
    if (annotation.colStart === null || annotation.colEnd === null) continue;
    const start = offsetAt(index, annotation.start, annotation.colStart);
    const end = offsetAt(index, annotation.end, annotation.colEnd);
    if (start === null || end === null || end < start) continue;
    spans.push({
      kind: annotation.kind,
      start,
      // Columns are inclusive; source offsets are half-open.
      end: end + 1,
      key: annotation.key,
    });
  }
  return spans;
}

/** Both decoration sources, merged into what the rehype plugin takes. */
export function mergeDecorations(
  changes: Decorations,
  annotations: SpanDecoration[],
): Decorations {
  return {
    spans: [...changes.spans, ...annotations],
    deletions: changes.deletions,
    blocks: changes.blocks,
  };
}
