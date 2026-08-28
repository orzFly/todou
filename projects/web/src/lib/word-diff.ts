import { Diff } from "diff";

/**
 * Word segmentation that works without spaces. jsdiff's own `diffWords`
 * splits on whitespace, so an edited Chinese sentence is one giant token
 * and the whole paragraph reads as changed — the exact complaint T-142
 * exists to fix. `Intl.Segmenter` knows where words end in CJK as well as
 * in English, and keeps whitespace and punctuation as their own segments,
 * which is what makes "one word replaced" come out as one word replaced.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

class WordDiff extends Diff<string, string> {
  tokenize(value: string): string[] {
    const tokens: string[] = [];
    for (const { segment } of segmenter.segment(value)) tokens.push(segment);
    return tokens;
  }

  join(tokens: string[]): string {
    return tokens.join("");
  }
}

const differ = new WordDiff();

/** Half-open character range `[start, end)`. */
export type WordDiffRange = { start: number; end: number };

/**
 * Text present in the old side and gone from the new one. `at` is where it
 * sat in the new text (a caret, not a span — deleted text has no new-side
 * extent); `from`/`to` locate it in the old text so the caller can quote it.
 */
export type WordDiffDeletion = { at: number; from: number; to: number };

export type WordDiffResult = {
  ins: WordDiffRange[];
  del: WordDiffDeletion[];
};

/** Word-level edits between two texts, as offsets into each side. */
export function wordDiff(oldText: string, newText: string): WordDiffResult {
  const ins: WordDiffRange[] = [];
  const del: WordDiffDeletion[] = [];
  if (oldText === newText) return { ins, del };

  let oldPos = 0;
  let newPos = 0;
  for (const part of differ.diff(oldText, newText)) {
    const length = part.value.length;
    if (part.added) {
      const last = ins.at(-1);
      if (last !== undefined && last.end === newPos) last.end = newPos + length;
      else ins.push({ start: newPos, end: newPos + length });
      newPos += length;
    } else if (part.removed) {
      const last = del.at(-1);
      if (last !== undefined && last.at === newPos && last.to === oldPos) {
        last.to = oldPos + length;
      } else {
        del.push({ at: newPos, from: oldPos, to: oldPos + length });
      }
      oldPos += length;
    } else {
      oldPos += length;
      newPos += length;
    }
  }
  return { ins, del };
}
