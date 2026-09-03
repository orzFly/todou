import { matchByWords } from "./group-align.ts";
import type { TableMatrix } from "./spec-source-index.ts";

/** Which old positions became which new ones, and what neither side kept. */
export type Matching = {
  pairs: Array<[number, number]>;
  oldOnly: number[];
  newOnly: number[];
};

export type TableAlignment = { columns: Matching; rows: Matching };

/** One row or one column, as a candidate for pairing. */
type Candidate = {
  index: number;
  /** Header text for a column, key-cell text for a row; null abstains. */
  key: string | null;
  /** All of it, for the word bag to weigh when the key found nothing. */
  text: string;
};

const compare = (a: number, b: number) => a - b;

/**
 * Pair equal keys in order of appearance. Position deliberately does not enter
 * into it: two columns swapped are still those two columns, and a table whose
 * rows were reordered has nothing removed and nothing added.
 */
function matchByKey(
  olds: Candidate[],
  news: Candidate[],
): Array<[number, number]> {
  const queues = new Map<string, number[]>();
  news.forEach((candidate, j) => {
    if (candidate.key === null) return;
    const queue = queues.get(candidate.key);
    if (queue === undefined) queues.set(candidate.key, [j]);
    else queue.push(j);
  });
  const pairs: Array<[number, number]> = [];
  olds.forEach((candidate, i) => {
    if (candidate.key === null) return;
    const j = queues.get(candidate.key)?.shift();
    if (j === undefined) return;
    pairs.push([i, j]);
  });
  return pairs;
}

/** Keys first, then words for whatever the keys left over (T-211's rules). */
function pairCandidates(olds: Candidate[], news: Candidate[]): Matching {
  const pairs: Array<[number, number]> = [];
  const takenOld = new Set<number>();
  const takenNew = new Set<number>();
  for (const [i, j] of matchByKey(olds, news)) {
    const old = olds[i];
    const nu = news[j];
    if (old === undefined || nu === undefined) continue;
    pairs.push([old.index, nu.index]);
    takenOld.add(i);
    takenNew.add(j);
  }
  const restOld = olds.filter((_, i) => !takenOld.has(i));
  const restNew = news.filter((_, j) => !takenNew.has(j));
  const matching = matchByWords(
    restOld.map((candidate) => candidate.text),
    restNew.map((candidate) => candidate.text),
  );
  for (const [i, j] of matching.pairs) {
    const old = restOld[i];
    const nu = restNew[j];
    if (old === undefined || nu === undefined) continue;
    pairs.push([old.index, nu.index]);
  }
  const oldOnly: number[] = [];
  for (const [i] of matching.oldOnly) {
    const old = restOld[i];
    if (old !== undefined) oldOnly.push(old.index);
  }
  const newOnly: number[] = [];
  for (const j of matching.newOnly) {
    const nu = restNew[j];
    if (nu !== undefined) newOnly.push(nu.index);
  }
  // Document order, so a caller reading the result reads the table.
  pairs.sort((a, b) => a[0] - b[0]);
  return {
    pairs,
    oldOnly: oldOnly.sort(compare),
    newOnly: newOnly.sort(compare),
  };
}

const textAt = (matrix: TableMatrix, row: number, col: number): string =>
  matrix.rows[row]?.cells[col]?.text ?? "";

/** Header text and the whole column beneath it, joined the way prose is. */
function columnsOf(matrix: TableMatrix): Candidate[] {
  const width = matrix.rows[0]?.cells.length ?? 0;
  return Array.from({ length: width }, (_, col) => ({
    index: col,
    key: textAt(matrix, 0, col),
    text: matrix.rows.map((_, row) => textAt(matrix, row, col)).join("\n"),
  }));
}

/** Body rows only: the header row pairs with the header row by definition. */
function rowsOf(matrix: TableMatrix, key: number | null): Candidate[] {
  const candidates: Candidate[] = [];
  for (let row = 1; row < matrix.rows.length; row++) {
    const cells = matrix.rows[row]?.cells ?? [];
    candidates.push({
      index: row,
      // A cell the page pads in abstains from being a key, but the row it is
      // in still competes on its words.
      key: key === null ? null : (cells[key]?.text ?? null),
      text: cells.map((cell) => cell?.text ?? "").join("\n"),
    });
  }
  return candidates;
}

/**
 * Line one table up against another, by column and by row (T-221). This is the
 * partition the cells then compete inside: a cell only ever meets the cell at
 * the crossing of a paired row and a paired column, so dropping a column costs
 * one column rather than one mark per cell, and swapping two columns costs
 * nothing at all.
 *
 * Both dimensions ask the same two questions, and they are T-211's: a key that
 * matches exactly settles it — the header for a column, the leftmost surviving
 * column's cell for a row — and whatever the keys leave over goes to
 * `matchByWords`, where one against one pairs on position and more than one
 * has to clear the word-bag floor. Nothing here reads a threshold of its own.
 *
 * The row/column pairing follows the approach of Rich Markdown Diff's
 * `tableDiff.ts` (phine-apps, MIT); its own thresholds — a header must match
 * exactly, a row needs half its cells or two of them — are not used, because
 * a renamed header would then cost a whole column and the two row measures
 * duplicate the similarity floor we already have.
 */
export function alignTable(old: TableMatrix, nu: TableMatrix): TableAlignment {
  const columns = pairCandidates(columnsOf(old), columnsOf(nu));
  // The leftmost column that survived: whatever names the rows, it is the one
  // a reader would look at to find a row again.
  const keyPair = columns.pairs[0] ?? null;
  const rows = pairCandidates(
    rowsOf(old, keyPair === null ? null : keyPair[0]),
    rowsOf(nu, keyPair === null ? null : keyPair[1]),
  );
  const header: Array<[number, number]> =
    old.rows.length > 0 && nu.rows.length > 0 ? [[0, 0]] : [];
  return { columns, rows: { ...rows, pairs: [...header, ...rows.pairs] } };
}
