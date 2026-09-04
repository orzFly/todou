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

/**
 * Word-like tokens of `text`, weighted by how many characters each spends.
 * This is what `alignGroups` scores a candidate pair with (T-211): the
 * question there is only "are these two the same block", and a bag of words
 * answers it without the quadratic cost of a real diff — which matters once
 * the run being scored is a whole rewritten section rather than one line
 * hunk. Spaces and punctuation stay out: T-180 already found those to be
 * the anchors that mean nothing.
 *
 * What it weighs is prose. A candidate that can also hold pictures goes
 * through `bagWith`, which counts those by identity instead (T-239).
 */
export type WordBag = { weights: Map<string, number>; total: number };

export function wordBag(text: string): WordBag {
  const weights = new Map<string, number>();
  let total = 0;
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike !== true) continue;
    weights.set(segment, (weights.get(segment) ?? 0) + segment.length);
    total += segment.length;
  }
  return { weights, total };
}

/**
 * What one picture is worth against one character of prose. It is a rate, not
 * a threshold — it rules nothing out, it only gives an image enough weight to
 * take part in the score at all. T-239 swept 1 through 20 and every fixture
 * came out identical; at 40 one picture outweighs all the prose beside it and
 * a table that lost an image stops resembling its own counterpart, so the
 * bottom of the flat range is what this takes.
 */
const IMAGE_WEIGHT = 1;

/** The bag of `text`, plus one entry for each of `urls`.
 *
 * An image used to reach the bag as its markdown source, and a word is weighed
 * by its characters, so `/api/projects/<slug>/attachments/<id>/download/` —
 * the path every attachment in one deployment shares — became the vocabulary
 * two unrelated tables had most in common (T-239). Two tables sharing nothing
 * but the fact of holding attachments scored 0.69 against each other while a
 * table and its real counterpart scored 0.22, and both numbers get worse the
 * longer the deployment spells that prefix.
 *
 * A url is an identity, not prose: worth counting that this picture is that
 * picture, worth nothing to count how many characters the path to it spends.
 * So each one lands as a single fixed-weight entry under a key no prose can
 * collide with — `wordBag` keeps `isWordLike` segments only, which one
 * non-word character in front is enough to stay clear of.
 */
export function bagWith(text: string, urls: string[]): WordBag {
  const bag = wordBag(text);
  for (const url of urls) {
    const key = `\u0000${url}`;
    bag.weights.set(key, (bag.weights.get(key) ?? 0) + IMAGE_WEIGHT);
    bag.total += IMAGE_WEIGHT;
  }
  return bag;
}

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

/**
 * The diff as alternating stretches: text both sides kept, and text one or
 * both of them replaced. jsdiff hands a removal and the insertion that took
 * its place over as two neighbouring parts; one `edit` holds both, because
 * what follows weighs a change against its neighbours and a change has two
 * sides.
 */
type EditRun = { kind: "edit"; del: string; ins: string };
type DiffRun = { kind: "eq"; text: string } | EditRun;

function diffRuns(oldText: string, newText: string): DiffRun[] {
  const runs: DiffRun[] = [];
  let edit: EditRun | null = null;
  for (const part of differ.diff(oldText, newText)) {
    if (part.added || part.removed) {
      if (edit === null) {
        edit = { kind: "edit", del: "", ins: "" };
        runs.push(edit);
      }
      if (part.added) edit.ins += part.value;
      else edit.del += part.value;
      continue;
    }
    edit = null;
    const last = runs.at(-1);
    if (last !== undefined && last.kind === "eq") last.text += part.value;
    else runs.push({ kind: "eq", text: part.value });
  }
  return runs;
}

/** How much a run of changed text weighs against a neighbouring anchor. */
function weightOf(run: EditRun): number {
  return Math.max(run.del.length, run.ins.length);
}

/**
 * Word-level edits with the anchors that cost more than they earn folded into
 * the change around them (T-180).
 *
 * A heavily rewritten line still shares spaces, punctuation and the odd single
 * character with the line it replaced, and every one of those the word diff
 * keeps cuts the rewrite apart: the reader is told `format.ts` became `引入`
 * and `East` became `sindresorhus，纯`, pairings that carry no meaning, while
 * the sentence's genuinely untouched tail drowns among the fragments. An
 * anchor is only worth drawing around when it outweighs the change on *both*
 * sides of it; a lighter one is folded in, and the two sides each run together
 * into a single coherent before and after.
 *
 * No threshold is involved, which is the point: a small edit keeps every
 * anchor it has and comes out word-level exactly as it did before, while a
 * line rewritten past the last surviving anchor degrades into the whole-block
 * before/after T-142 already renders for a pair that shares nothing. Weight is
 * in characters and a tie leaves the anchor standing — the conservative of the
 * two tiers T-180 weighed, and tightening it later is the one comparison
 * below.
 *
 * `wordDiff` keeps its bare output beside this one: coalescing answers "what
 * should the reader see", and anything measuring how much genuinely changed
 * would read a folded-in anchor as change that is not there.
 */
export function coalescedWordDiff(
  oldText: string,
  newText: string,
): WordDiffResult {
  if (oldText === newText) return { ins: [], del: [] };
  const runs = diffRuns(oldText, newText);

  // The first and last run are never anchors with a change on either side, so
  // the text a line opens and closes with survives however heavy the rewrite
  // between them — which is how the evidence line keeps its untouched tail.
  for (let i = 1; i + 1 < runs.length; ) {
    const anchor = runs[i];
    const before = runs[i - 1];
    const after = runs[i + 1];
    if (
      anchor?.kind !== "eq" ||
      before?.kind !== "edit" ||
      after?.kind !== "edit" ||
      anchor.text.length >= weightOf(before) ||
      anchor.text.length >= weightOf(after)
    ) {
      i++;
      continue;
    }
    runs.splice(i - 1, 3, {
      kind: "edit",
      del: before.del + anchor.text + after.del,
      ins: before.ins + anchor.text + after.ins,
    });
    // Leaving `i` where it is lands on the anchor after the merged run, which
    // now weighs itself against the heavier thing folding produced — that is
    // how a run of light anchors collapses together in one pass. An anchor
    // already found heavy enough is never revisited: letting a growing
    // neighbour come back for it would erode surviving anchors one at a time
    // until only the first and last stood, which is the aggressive tier T-180
    // ruled against.
  }

  const ins: WordDiffRange[] = [];
  const del: WordDiffDeletion[] = [];
  let oldPos = 0;
  let newPos = 0;
  for (const run of runs) {
    if (run.kind === "eq") {
      oldPos += run.text.length;
      newPos += run.text.length;
      continue;
    }
    if (run.del !== "") {
      del.push({ at: newPos, from: oldPos, to: oldPos + run.del.length });
      oldPos += run.del.length;
    }
    if (run.ins !== "") {
      ins.push({ start: newPos, end: newPos + run.ins.length });
      newPos += run.ins.length;
    }
  }
  return { ins, del };
}

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
