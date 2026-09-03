import { diffArrays } from "diff";
import type { SourceBlockType } from "./spec-source-index.ts";
import { type WordBag, wordBag } from "./word-diff.ts";

/** One leaf block, as a candidate for alignment. */
export type AlignGroup = {
  /** Leaf-group number, i.e. an index into `SegmentIndex.groupTypes`. */
  group: number;
  /** null when the block table had no type for it; then it pairs only with null. */
  type: SourceBlockType | null;
  /** The group's slice of the owning `SegmentIndex.text`; a fence's own source. */
  text: string;
  /** Offset of `text[0]` in that same flattened text; -1 for a fence, which is not in it. */
  at: number;
};

export type Alignment = {
  /** Old block and the new block that replaced it, in document order. */
  pairs: Array<{ old: AlignGroup; new: AlignGroup }>;
  /**
   * Old groups nothing replaced. `newIndex` counts the new-side groups that
   * precede each one, which is how the caller finds the seam its marker goes
   * in; two entries sharing a `newIndex` have nothing new between them and
   * belong in the same marker.
   */
  oldOnly: Array<{ group: AlignGroup; newIndex: number }>;
  /** New groups nothing on the old side became. */
  newOnly: AlignGroup[];
};

/** The same three outcomes as `Alignment`, but by index (T-221). */
export type WordMatching = {
  pairs: Array<[number, number]>;
  /**
   * Each unmatched old index, with the new index it lost to — `news.length`
   * when it lost to nothing. That is where its marker belongs.
   */
  oldOnly: Array<[number, number]>;
  newOnly: number[];
};

/**
 * Below this share of common words, two blocks are two blocks rather than one
 * rewritten — pairing them would diff unrelated prose and scatter marks
 * through both. It only ever gets asked where more than one candidate
 * competes; where the position is unique it says nothing (see `matchRun`).
 */
const SIMILARITY_FLOOR = 1 / 3;

/**
 * Past this many candidate pairs, scoring stops paying for itself and the run
 * degrades to pairing by position. Word-bag scoring measures at roughly 3 µs a
 * pair, so ten thousand of them cost about 30 ms: this is a safety net against
 * pathological input, not a threshold the ordinary document approaches. The
 * widest run across T-207's and T-203's real revisions is 30 blocks against 14.
 */
const PAIRS_GUARD = 10_000;

const PROSE_LEAVES = new Set<SourceBlockType>(["paragraph", "heading"]);

/** What a leaf may be confused with: itself, and nothing across the line. */
type Class = "none" | "prose" | SourceBlockType;

/**
 * A table only ever pairs with a table, and that is the whole fix for T-163:
 * a paragraph replaced by a table can no longer have its words matched into
 * the cells that replaced it, so no `<del>` lands in a header and no cell
 * keeps word boxes the absorbing block should have swallowed. Paragraph and
 * heading do pair — promoting one to the other is an ordinary edit that reads
 * well word by word. A fence pairs only with a fence.
 *
 * Since T-221 a document's leaves hold whole tables rather than single cells,
 * and what is inside a paired one is `alignTable`'s question. `tableCell`
 * keeps its class for the leaves a test builds by hand.
 */
function classOf(type: SourceBlockType | null): Class {
  if (type === null) return "none";
  return PROSE_LEAVES.has(type) ? "prose" : type;
}

/** Shared word weight as a fraction of both bags, 0…1 (Dice). */
function bagSimilarity(a: WordBag, b: WordBag): number {
  const total = a.total + b.total;
  if (total === 0) return 1;
  let shared = 0;
  for (const [word, weight] of a.weights) {
    const other = b.weights.get(word);
    if (other !== undefined) shared += Math.min(weight, other);
  }
  return (2 * shared) / total;
}

/** Neither side has a counterpart: everything here stands alone. */
function unmatched(
  olds: AlignGroup[],
  news: AlignGroup[],
  newIndex: number,
  out: Alignment,
): void {
  for (const group of olds) out.oldOnly.push({ group, newIndex });
  out.newOnly.push(...news);
}

/** Pair by position, and let the surplus stand alone. */
function zip(m: number, n: number): WordMatching {
  const shared = Math.min(m, n);
  const out: WordMatching = { pairs: [], oldOnly: [], newOnly: [] };
  for (let i = 0; i < shared; i++) out.pairs.push([i, i]);
  for (let i = shared; i < m; i++) out.oldOnly.push([i, n]);
  for (let j = shared; j < n; j++) out.newOnly.push(j);
  return out;
}

/** The best non-crossing set of pairs, weighed by how much each shares. */
function score(olds: string[], news: string[]): WordMatching {
  const out: WordMatching = { pairs: [], oldOnly: [], newOnly: [] };
  const m = olds.length;
  const n = news.length;
  // One bag per leaf, not one per candidate pair: segmenting is the expensive
  // half, and a run of 30 against 14 asks about the same leaf 14 times.
  const oldBags = olds.map(wordBag);
  const newBags = news.map(wordBag);
  const sims = new Array<number>(m * n).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const a = oldBags[i];
      const b = newBags[j];
      if (a === undefined || b === undefined) continue;
      const shared = bagSimilarity(a, b);
      if (shared >= SIMILARITY_FLOOR) sims[i * n + j] = shared;
    }
  }

  // dp[i][j] is the best total similarity obtainable from olds[i…] against
  // news[j…]. Pairs cannot cross, so the choice at each cell is only: pair
  // these two, drop the old one, or drop the new one.
  const width = n + 1;
  const dp = new Array<number>((m + 1) * width).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const sim = sims[i * n + j] ?? Number.NEGATIVE_INFINITY;
      const paired = sim + (dp[(i + 1) * width + j + 1] ?? 0);
      dp[i * width + j] = Math.max(
        dp[(i + 1) * width + j] ?? 0,
        dp[i * width + j + 1] ?? 0,
        paired,
      );
    }
  }

  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    const old = i < m ? olds[i] : undefined;
    const nu = j < n ? news[j] : undefined;
    const best = dp[i * width + j] ?? 0;
    const sim =
      old === undefined || nu === undefined
        ? Number.NEGATIVE_INFINITY
        : (sims[i * n + j] ?? Number.NEGATIVE_INFINITY);
    if (
      old !== undefined &&
      nu !== undefined &&
      sim !== Number.NEGATIVE_INFINITY &&
      best === sim + (dp[(i + 1) * width + j + 1] ?? 0)
    ) {
      out.pairs.push([i, j]);
      i++;
      j++;
    } else if (
      old !== undefined &&
      (nu === undefined || best === (dp[(i + 1) * width + j] ?? 0))
    ) {
      out.oldOnly.push([i, j]);
      i++;
    } else if (nu !== undefined) {
      out.newOnly.push(j);
      j++;
    } else break;
  }
  return out;
}

/**
 * Which of `olds` became which of `news`, by index — the judgement `matchRun`
 * makes within one type class, on its own so that `alignTable` can ask it of a
 * table's rows and of its columns too (T-221).
 *
 * The shape is the whole of it. One against one: the position is unique, so it
 * *is* the evidence — this became that, and how much of it survived is
 * `coalescedWordDiff`'s question, not this one's. T-142's 二→三 shares no
 * character and T-180's whole-line rewrite shares almost none; both are still
 * one block rewritten. More than one candidate on either side: the position no
 * longer says which went with which, so words decide, and a candidate below
 * the similarity floor is nobody's counterpart.
 */
export function matchByWords(olds: string[], news: string[]): WordMatching {
  const m = olds.length;
  const n = news.length;
  if (m === 0 || n === 0) {
    return {
      pairs: [],
      oldOnly: Array.from({ length: m }, (_, i): [number, number] => [i, n]),
      newOnly: Array.from({ length: n }, (_, j) => j),
    };
  }
  if (m === 1 && n === 1) return { pairs: [[0, 0]], oldOnly: [], newOnly: [] };
  if (m * n > PAIRS_GUARD) return zip(m, n);
  return score(olds, news);
}

/**
 * One run of replaced leaves, between two anchors, decided one type class at a
 * time. A class is settled on its own because the classes never pair with each
 * other anyway, and lumping them together only misreads the shape of the run:
 * `intro` → `outro` beside an edited fence is two 1×1 questions, not one 2×2,
 * and asked as a 2×2 the two single words would have to clear the similarity
 * floor they share nothing to clear.
 *
 * Within a class, `matchByWords` decides; this maps its indexes back onto the
 * leaves and onto the seam an unmatched old leaf fell at. The one case kept
 * here is a class with nothing on one side, whose seam is the run's own base
 * rather than any leaf's position.
 */
function matchRun(
  olds: AlignGroup[],
  news: AlignGroup[],
  base: number,
  out: Alignment,
): void {
  const local: Alignment = { pairs: [], oldOnly: [], newOnly: [] };
  const classes: Class[] = [];
  for (const leaf of [...olds, ...news]) {
    const c = classOf(leaf.type);
    if (!classes.includes(c)) classes.push(c);
  }
  for (const c of classes) {
    const mine = olds.filter((leaf) => classOf(leaf.type) === c);
    const theirs: AlignGroup[] = [];
    const at: number[] = [];
    for (let j = 0; j < news.length; j++) {
      const leaf = news[j];
      if (leaf === undefined || classOf(leaf.type) !== c) continue;
      theirs.push(leaf);
      at.push(j);
    }
    // Where an old leaf with no counterpart falls, in the whole new side's
    // coordinates: at the new leaf of its own class it lost to, or at the end
    // of the run when it lost to nothing.
    const seam = (j: number) => base + (at[j] ?? news.length);
    if (mine.length === 0 || theirs.length === 0) {
      unmatched(mine, theirs, base, local);
      continue;
    }
    const matching = matchByWords(
      mine.map((leaf) => leaf.text),
      theirs.map((leaf) => leaf.text),
    );
    for (const [i, j] of matching.pairs) {
      const old = mine[i];
      const nu = theirs[j];
      if (old === undefined || nu === undefined) continue;
      local.pairs.push({ old, new: nu });
    }
    for (const [i, j] of matching.oldOnly) {
      const old = mine[i];
      if (old === undefined) continue;
      local.oldOnly.push({ group: old, newIndex: seam(j) });
    }
    for (const j of matching.newOnly) {
      const nu = theirs[j];
      if (nu !== undefined) local.newOnly.push(nu);
    }
  }
  // Back into document order: the classes were settled one after another, and
  // `clusterDeletions` downstream reads neighbouring removals as one marker.
  local.pairs.sort((a, b) => a.old.group - b.old.group);
  local.oldOnly.sort((a, b) => a.group.group - b.group.group);
  local.newOnly.sort((a, b) => a.group - b.group);
  out.pairs.push(...local.pairs);
  out.oldOnly.push(...local.oldOnly);
  out.newOnly.push(...local.newOnly);
}

/**
 * Line up two versions leaf block by leaf block, before anything looks at
 * their words (T-163). Word-level diffing a whole edit at once lets prose from
 * one block match prose in another; running it per aligned block cannot, and a
 * block left without a counterpart is the direct evidence that it was added or
 * removed whole.
 *
 * The scope of one alignment is the whole document (T-211). It used to be a
 * line hunk, which put the answer at the mercy of where jsdiff happened to cut
 * — a single blank line counted as an anchor, and the heading renumbered
 * behind a deleted paragraph landed in a different hunk from the heading it
 * came from, so the two never met. Lines are markdown's typographical unit,
 * not its content: blank lines, `| --- |` and list bullets are all lines and
 * none of them is a block. Leaves whose text is identical are the anchors
 * here, and only the leaves between two of them compete.
 */
export function alignGroups(olds: AlignGroup[], news: AlignGroup[]): Alignment {
  const out: Alignment = { pairs: [], oldOnly: [], newOnly: [] };
  let oldRun: AlignGroup[] = [];
  let newRun: AlignGroup[] = [];
  let oldAt = 0;
  let newAt = 0;
  const flush = () => {
    if (oldRun.length > 0 || newRun.length > 0) {
      matchRun(oldRun, newRun, newAt - newRun.length, out);
    }
    oldRun = [];
    newRun = [];
  };
  const parts = diffArrays(
    olds.map((g) => g.text),
    news.map((g) => g.text),
  );
  for (const part of parts) {
    const count = part.count ?? part.value.length;
    if (part.removed) {
      oldRun.push(...olds.slice(oldAt, oldAt + count));
      oldAt += count;
    } else if (part.added) {
      newRun.push(...news.slice(newAt, newAt + count));
      newAt += count;
    } else {
      // An anchor: same text on both sides, so there is nothing to draw on
      // it, and it closes whatever run was accumulating.
      flush();
      oldAt += count;
      newAt += count;
    }
  }
  flush();
  return out;
}
