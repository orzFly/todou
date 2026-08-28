import type {
  Decorations,
  DeletionDecoration,
  SpanDecoration,
} from "./rehype-decorations.ts";
import { changedBlockPairs } from "./spec-changes.ts";
import {
  groupSpanOfText,
  offsetAt,
  type SegmentIndex,
  segmentsInLines,
  sourceOffsetOfText,
  sourceRangesOfText,
  textRangeOf,
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
 * Word-level diff of two versions, as decorations on the newer one (T-142).
 * The block-level "changed since vN" wash stays where it is and keeps
 * driving the ↑↓ navigation; this is what tells the reader *which words*
 * inside those blocks moved.
 */
export function changeDecorations(
  baseline: SegmentIndex,
  current: SegmentIndex,
): Decorations {
  const spans: SpanDecoration[] = [];
  const deletions: DeletionDecoration[] = [];

  const insert = (from: number, to: number) => {
    for (const range of sourceRangesOfText(current, from, to)) {
      spans.push({ kind: "ins", start: range.start, end: range.end });
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
    // Lines with no prose at all — a code fence, a table rule — carry no
    // inline decoration; their block keeps the plain "changed" highlight.
    if (after === null) continue;
    const before =
      pair.old === null
        ? null
        : textRangeOf(segmentsInLines(baseline, pair.old));
    if (before === null) {
      insert(after.start, after.end);
      continue;
    }

    const result = wordDiff(
      baseline.text.slice(before.start, before.end),
      current.text.slice(after.start, after.end),
    );
    for (const range of result.ins) {
      insert(after.start + range.start, after.start + range.end);
    }
    for (const gone of result.del) {
      const from = before.start + gone.from;
      const to = before.start + gone.to;
      const text = baseline.text.slice(from, to);
      if (text.trim() === "") continue;
      const at = sourceOffsetOfText(current, after.start + gone.at);
      if (at === null) continue;
      deletions.push({
        at,
        text: text.trim(),
        // Text that spanned two leaf blocks has no single line to strike
        // through — a whole paragraph or table row went away, and that
        // degrades to a marker (T-142 Q1).
        block: groupSpanOfText(baseline, from, to) > 1,
      });
    }
  }
  return { spans, deletions };
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
  };
}
