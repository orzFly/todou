import { diffLines } from "diff";

export type LineRange = { start: number; end: number };

/**
 * 1-based inclusive line ranges of `newBody` that differ from `oldBody`
 * (insertions and rewrites; a pure deletion leaves no new lines to mark).
 * Drives the re-review aids: green "changed since vX" highlights and the
 * prev/next-change navigation (#23 phase 3).
 */
export function changedLineRanges(
  oldBody: string,
  newBody: string,
): LineRange[] {
  if (oldBody === newBody) return [];
  const ranges: LineRange[] = [];
  let newPos = 1;
  for (const part of diffLines(oldBody, newBody)) {
    const count = part.count ?? 0;
    if (part.added) {
      const range = { start: newPos, end: newPos + count - 1 };
      const last = ranges.at(-1);
      // Merge adjacent ranges (a rewrite is a remove+add pair and larger
      // edits interleave) so one edit reads as one nav stop.
      if (last && range.start <= last.end + 1) last.end = range.end;
      else ranges.push(range);
      newPos += count;
    } else if (!part.removed) {
      newPos += count;
    }
  }
  return ranges;
}

export function rangesIntersect(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}
