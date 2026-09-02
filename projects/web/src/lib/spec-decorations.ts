import { type AlignGroup, alignGroups } from "./group-align.ts";
import type {
  Decorations,
  DeletionDecoration,
  SpanDecoration,
} from "./rehype-decorations.ts";
import {
  blocksWhollyInGroups,
  offsetAt,
  outermostBlockOfGroup,
  type SegmentIndex,
  type SourceRange,
  sourceOffsetOfText,
  sourceRangesOfText,
} from "./spec-source-index.ts";
import { coalescedWordDiff } from "./word-diff.ts";

/** An annotation as the document sees it: which slice of source it covers. */
export type AnchoredAnnotation = {
  key: string;
  kind: "comment" | "draft";
  start: number;
  end: number;
  colStart: number | null;
  colEnd: number | null;
};

/**
 * Every leaf block of a document, in document order — what one side of an
 * alignment is made of (T-211).
 *
 * Prose leaves come out of the segment table: the segments of one group are
 * contiguous in the flattened text, so a group is a slice of it and needs no
 * reassembly. A fence contributes no prose at all, so it comes out of the
 * block table instead and carries its own source, fences and all; `at` is -1
 * because there is no flattened text for it to sit in.
 */
export function leavesOf(index: SegmentIndex): AlignGroup[] {
  const leaves: AlignGroup[] = [];
  for (const segment of index.segments) {
    const last = leaves.at(-1);
    if (last !== undefined && last.group === segment.group) {
      last.text = index.text.slice(last.at, segment.at + segment.text.length);
      continue;
    }
    leaves.push({
      group: segment.group,
      type: index.groupTypes[segment.group] ?? null,
      text: segment.text,
      at: segment.at,
    });
  }
  for (const block of index.blocks) {
    if (block.type !== "code" || block.firstGroup < 0) continue;
    leaves.push({
      group: block.firstGroup,
      type: "code",
      text: index.source.slice(block.start, block.end),
      at: -1,
    });
  }
  // Group numbers are handed out in document order, so this is document order.
  return leaves.sort((a, b) => a.group - b.group);
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
 * Which of them stayed is answered per leaf block (T-163): the two sides are
 * aligned block against block first, and only then are words compared inside
 * each match. A block left without a match is the evidence — it was born, or
 * it went — where before the answer had to be inferred from how far a flat
 * word diff's insertions happened to reach.
 *
 * And inside a match, the same question is asked once more of every anchor
 * the word diff found (T-180): the words are compared through
 * `coalescedWordDiff`, so an anchor too light to pay for the two boxes it
 * opens is folded into the change instead of cutting it in half.
 *
 * All of it happens once, over the whole document (T-211). There is no line
 * evidence here any more and no per-hunk branch: `changedLineRanges` still
 * drives the wash and the navigation, but which block became which is decided
 * without ever asking where the lines fell. Three outcomes, three renderings —
 * a pair gets words, a new leaf gets a block highlight, a lost leaf gets a
 * marker at the seam it left.
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

  const newLeaves = leavesOf(current);
  const alignment = alignGroups(leavesOf(baseline), newLeaves);

  for (const matched of alignment.pairs) {
    // pierre owns the inside of a fence (T-31): a paired code block gets the
    // block-level wash it already has and nothing else.
    if (matched.old.type === "code" || matched.new.type === "code") continue;
    const result = coalescedWordDiff(matched.old.text, matched.new.text);
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

  // Take the whole blocks the new leaves build, then word-mark only the
  // leaves those blocks left over.
  const born = new Set(alignment.newOnly.map((leaf) => leaf.group));
  const absorbed = new Set<number>();
  for (const block of blocksWhollyInGroups(current, born)) {
    blocks.push({ start: block.start, end: block.end });
    for (let g = block.firstGroup; g <= block.lastGroup; g++) absorbed.add(g);
  }
  for (const leaf of alignment.newOnly) {
    // A fence always qualifies as a whole block, so it is absorbed above and
    // never reaches this; if it ever did there would be no text node to mark.
    if (absorbed.has(leaf.group) || leaf.at < 0) continue;
    insert(leaf.at, leaf.at + leaf.text.length);
  }

  // Old blocks with no counterpart have nowhere to be struck through, so they
  // degrade to a marker at the seam. The text is the baseline's own source —
  // a whole table row reads as the row, `| --- |` and all — which is why the
  // outermost gone block, not the leaf, is what gets quoted (T-209).
  // Neighbours with nothing new between them share one marker.
  const gone = new Set(alignment.oldOnly.map((entry) => entry.group.group));
  const seams = new Map(
    alignment.oldOnly.map((entry) => [entry.group.group, entry.newIndex]),
  );
  const removed: Array<{ order: number; newIndex: number; text: string }> = [];
  const covered = new Set<number>();
  for (const block of blocksWhollyInGroups(baseline, gone)) {
    let seam: number | undefined;
    for (let g = block.firstGroup; g <= block.lastGroup; g++) {
      covered.add(g);
      seam ??= seams.get(g);
    }
    if (seam === undefined) continue;
    removed.push({
      order: block.firstGroup,
      newIndex: seam,
      text: baseline.source.slice(block.start, block.end),
    });
  }
  for (const entry of alignment.oldOnly) {
    if (covered.has(entry.group.group)) continue;
    removed.push({
      order: entry.group.group,
      newIndex: entry.newIndex,
      text: entry.group.text,
    });
  }
  removed.sort((a, b) => a.order - b.order);
  for (const cluster of clusterDeletions(removed)) {
    const text = cluster.texts.join("\n");
    if (text.trim() === "") continue;
    deletions.push({
      at: seamAt(current, newLeaves, cluster.newIndex),
      text,
      block: true,
    });
  }
  return { spans, deletions, blocks };
}

/** Unmatched old blocks that sit at the same seam, merged into one marker. */
function clusterDeletions(
  removed: Array<{ newIndex: number; text: string }>,
): Array<{ newIndex: number; texts: string[] }> {
  const clusters: Array<{ newIndex: number; texts: string[] }> = [];
  for (const entry of removed) {
    const last = clusters.at(-1);
    if (last !== undefined && last.newIndex === entry.newIndex) {
      last.texts.push(entry.text);
    } else clusters.push({ newIndex: entry.newIndex, texts: [entry.text] });
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
  leaves: AlignGroup[],
  newIndex: number,
): number {
  const after = leaves[newIndex];
  if (after !== undefined) {
    const block = outermostBlockOfGroup(index, after.group);
    if (block !== null) return block.start;
  }
  const before = leaves[newIndex - 1];
  if (before !== undefined) {
    const block = outermostBlockOfGroup(index, before.group);
    if (block !== null) return block.end;
  }
  return index.source.length;
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
