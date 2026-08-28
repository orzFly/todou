import { diffLines } from "diff";

export type LineRange = { start: number; end: number };

/**
 * 1-based inclusive line ranges of `newBody` that differ from `oldBody`
 * (insertions and rewrites; a pure deletion leaves no new lines to mark).
 * Drives the re-review aids: green "changed since vX" highlights and the
 * prev/next-change navigation (T-23 phase 3).
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

/**
 * One edit, both sides. A rewrite pairs the lines it replaced with the lines
 * that replaced them; a pure insertion has no old side and a pure deletion
 * no new side. This is what `changedLineRanges` throws away, and what the
 * word-level diff needs: the old text to compare the new text against
 * (T-142).
 */
export type ChangedBlockPair = {
  old: LineRange | null;
  new: LineRange | null;
  /**
   * New-side line the edit sits at. Same as `new.start` when there is a
   * new side; for a pure deletion it names the line that closed over the
   * hole, which is the only place a "something was here" marker can go.
   */
  at: number;
};

/** 1-based inclusive line ranges, paired edit by edit. */
export function changedBlockPairs(
  oldBody: string,
  newBody: string,
): ChangedBlockPair[] {
  if (oldBody === newBody) return [];
  const pairs: ChangedBlockPair[] = [];
  let pending: ChangedBlockPair | null = null;
  let oldPos = 1;
  let newPos = 1;
  const grow = (
    side: LineRange | null,
    start: number,
    count: number,
  ): LineRange => ({
    start: side?.start ?? start,
    end: start + count - 1,
  });
  for (const part of diffLines(oldBody, newBody)) {
    const count = part.count ?? 0;
    if (part.removed) {
      // jsdiff emits a rewrite as removed-then-added, so both sides of one
      // edit land in the same pending pair.
      pending ??= { old: null, new: null, at: newPos };
      pending.old = grow(pending.old, oldPos, count);
      oldPos += count;
    } else if (part.added) {
      pending ??= { old: null, new: null, at: newPos };
      pending.new = grow(pending.new, newPos, count);
      newPos += count;
    } else {
      if (pending !== null) pairs.push(pending);
      pending = null;
      oldPos += count;
      newPos += count;
    }
  }
  if (pending !== null) pairs.push(pending);
  return pairs;
}
