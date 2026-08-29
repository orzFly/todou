import { diffArrays } from "diff";
import type { SourceBlockType } from "./spec-source-index.ts";
import { wordDiff } from "./word-diff.ts";

/** One leaf block's prose, as a candidate for alignment. */
export type AlignGroup = {
  /** Leaf-group number, i.e. an index into `SegmentIndex.groupTypes`. */
  group: number;
  /** null when the block table had no type for it; then it pairs only with null. */
  type: SourceBlockType | null;
  /** The group's slice of the owning `SegmentIndex.text`. */
  text: string;
  /** Offset of `text[0]` in that same flattened text. */
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

/**
 * Below this share of common text, two blocks are two blocks rather than one
 * rewritten — pairing them would diff unrelated prose and scatter marks
 * through both.
 */
const SIMILARITY_FLOOR = 1 / 3;

/**
 * Past this many candidate pairs the m·n word diffs stop paying for
 * themselves; a wholesale table reshuffle is the case that gets here.
 */
const PAIRS_GUARD = 100;

const PROSE_LEAVES = new Set<SourceBlockType>(["paragraph", "heading"]);

/**
 * A table cell only ever pairs with a table cell, and that is the whole fix
 * for T-163: a paragraph replaced by a table can no longer have its words
 * matched into the cells that replaced it, so no `<del>` lands in a header
 * and no cell keeps word boxes the absorbing block should have swallowed.
 * Paragraph and heading do pair — promoting one to the other is an ordinary
 * edit that reads well word by word.
 */
function compatible(
  a: SourceBlockType | null,
  b: SourceBlockType | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  return PROSE_LEAVES.has(a) && PROSE_LEAVES.has(b);
}

/** Shared characters as a fraction of both texts, 0…1. */
function similarity(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  let added = 0;
  for (const range of wordDiff(a, b).ins) added += range.end - range.start;
  return (2 * (b.length - added)) / total;
}

/** Neither side has a counterpart: everything here stands alone. */
function unmatched(
  olds: AlignGroup[],
  news: AlignGroup[],
  base: number,
  out: Alignment,
): void {
  for (const group of olds) out.oldOnly.push({ group, newIndex: base });
  out.newOnly.push(...news);
}

/** Pair by position, skipping the pairs whose types disagree. */
function zip(
  olds: AlignGroup[],
  news: AlignGroup[],
  base: number,
  out: Alignment,
): void {
  const shared = Math.min(olds.length, news.length);
  for (let i = 0; i < shared; i++) {
    const old = olds[i];
    const nu = news[i];
    if (old === undefined || nu === undefined) continue;
    if (compatible(old.type, nu.type)) out.pairs.push({ old, new: nu });
    else unmatched([old], [nu], base + i, out);
  }
  unmatched(olds.slice(shared), news.slice(shared), base + news.length, out);
}

/**
 * One run of replaced blocks, between two anchors. The shape of the run is
 * what decides how hard to look for counterparts.
 */
function matchRun(
  olds: AlignGroup[],
  news: AlignGroup[],
  base: number,
  out: Alignment,
): void {
  const m = olds.length;
  const n = news.length;
  if (m === 0 || n === 0) {
    unmatched(olds, news, base, out);
    return;
  }
  const first = olds[0];
  const only = news[0];
  // One block for one block: a rewrite that shares no words at all is still
  // a rewrite — T-142's flagship 二→三 has a similarity of zero and has to
  // come out word-level — so similarity gets no vote here.
  if (m === 1 && n === 1 && first !== undefined && only !== undefined) {
    if (compatible(first.type, only.type))
      out.pairs.push({ old: first, new: only });
    else unmatched([first], [only], base, out);
    return;
  }
  if (m * n > PAIRS_GUARD) {
    zip(olds, news, base, out);
    return;
  }

  const sims = new Array<number>(m * n).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const old = olds[i];
      const nu = news[j];
      if (old === undefined || nu === undefined) continue;
      if (!compatible(old.type, nu.type)) continue;
      const score = similarity(old.text, nu.text);
      if (score >= SIMILARITY_FLOOR) sims[i * n + j] = score;
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
      out.pairs.push({ old, new: nu });
      i++;
      j++;
    } else if (
      old !== undefined &&
      (nu === undefined || best === (dp[(i + 1) * width + j] ?? 0))
    ) {
      out.oldOnly.push({ group: old, newIndex: base + j });
      i++;
    } else if (nu !== undefined) {
      out.newOnly.push(nu);
      j++;
    } else break;
  }
}

/**
 * Line up the leaf blocks of a rewrite's two sides before anything looks at
 * their words (T-163). Word-level diffing a whole rewrite pair at once lets
 * prose from one block match prose in another; running it per aligned block
 * cannot, and blocks left without a counterpart are the direct evidence that
 * they were added or removed whole.
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
