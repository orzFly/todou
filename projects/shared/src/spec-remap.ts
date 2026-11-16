import { diffLines } from "diff";

/**
 * Map a 1-based inclusive line range of `oldBody` onto `newBody`. The range
 * survives only when it sits wholly inside one unchanged region: anything
 * else — deletion overlap, insertion or deletion splitting it — means the
 * anchored text no longer reads the same, i.e. outdated (GitHub semantics).
 */
export function remapLineRange(
  oldBody: string,
  newBody: string,
  start: number,
  end: number,
): { outdated: boolean; start: number | null; end: number | null } {
  if (oldBody === newBody) return { outdated: false, start, end };
  let oldPos = 1;
  let newPos = 1;
  for (const part of diffLines(oldBody, newBody)) {
    const count = part.count ?? 0;
    if (part.added) {
      newPos += count;
    } else if (part.removed) {
      const oldEndEx = oldPos + count;
      if (start < oldEndEx && end >= oldPos) {
        return { outdated: true, start: null, end: null };
      }
      oldPos = oldEndEx;
    } else {
      const oldEndEx = oldPos + count;
      if (start >= oldPos && end < oldEndEx) {
        const shift = newPos - oldPos;
        return { outdated: false, start: start + shift, end: end + shift };
      }
      if (start >= oldPos && start < oldEndEx) {
        // Starts here but runs into the next change → split by an edit.
        return { outdated: true, start: null, end: null };
      }
      oldPos = oldEndEx;
      newPos += count;
    }
  }
  return { outdated: true, start: null, end: null };
}
