import { matchByWords } from "./group-align.ts";
import {
  partsText,
  type TableCell,
  type TableMatrix,
} from "./spec-source-index.ts";
import { bagWith, type WordBag } from "./word-diff.ts";

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
  /**
   * All of it, weighed, for when the key found nothing. Already a bag rather
   * than a string because prose and pictures are weighed by different rules
   * and only this end of the pipe still knows which run was which (T-239).
   */
  text: WordBag;
};

const compare = (a: number, b: number) => a - b;

/**
 * Pair equal keys in order of appearance. Position deliberately does not enter
 * into it: two columns swapped are still those two columns, and a table whose
 * rows were reordered has nothing removed and nothing added.
 *
 * Only the key is read, so the parameter says only that — `alignFrontmatter`
 * pairs on keys alone and has no bag to weigh.
 */
function matchByKey(
  olds: Array<{ key: string | null }>,
  news: Array<{ key: string | null }>,
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

/**
 * What a cell brings to the pairing; null for a cell the page only pads in.
 * The distinction is the whole reason this is not a `?.` chain: a padded cell
 * abstains, an empty one competes with the empty string.
 */
const cellText = (cell: TableCell | null | undefined): string | null =>
  cell === undefined || cell === null ? null : partsText(cell.parts);

const textAt = (matrix: TableMatrix, row: number, col: number): string =>
  cellText(matrix.rows[row]?.cells[col]) ?? "";

type Cell = TableCell | null | undefined;

/**
 * The two halves of what a cell brings to a score, kept apart (T-239). `key`
 * still reads them together through `partsText`, and must: a key is compared
 * for exact equality, where a url is a perfect identity and the reason T-230's
 * picture-only rows pair at all. A bag is compared by weight, where the same
 * url is a shared path spelled at length.
 */
const proseOf = (cell: Cell): string =>
  cell === undefined || cell === null
    ? ""
    : cell.parts
        .map((part) => (part.kind === "text" ? part.text : ""))
        .join("");

const urlsOf = (cell: Cell): string[] =>
  cell === undefined || cell === null
    ? []
    : cell.parts.flatMap((part) => (part.kind === "image" ? [part.url] : []));

const weigh = (cells: Cell[]): WordBag =>
  bagWith(cells.map(proseOf).join("\n"), cells.flatMap(urlsOf));

/** Header text and the whole column beneath it, joined the way prose is. */
function columnsOf(matrix: TableMatrix): Candidate[] {
  const width = matrix.rows[0]?.cells.length ?? 0;
  return Array.from({ length: width }, (_, col) => ({
    index: col,
    key: textAt(matrix, 0, col),
    text: weigh(matrix.rows.map((row) => row.cells[col])),
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
      key: key === null ? null : cellText(cells[key]),
      text: weigh(cells),
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
 * A key counts a cell's images along with its prose (T-230): where the key
 * column holds nothing but pictures, every key is the empty string, order of
 * appearance is all that is left to pair on, and deleting the first row is
 * reported as deleting the last.
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

/** Every field's key, by row; row 0 is a field like any other. */
const keysOf = (matrix: TableMatrix): Array<{ key: string | null }> =>
  matrix.rows.map((row) => ({ key: cellText(row.cells[0]) }));

/**
 * Line up the fields of one frontmatter block against another's (T-240). Two
 * columns and no header row, so the whole question is which key became which —
 * and the answer is only ever "the one spelled the same".
 *
 * That last word is where this parts company with `alignTable`, and the
 * difference was measured. Run a real `key | value` table through the existing
 * mechanism and three of the four field outcomes already come out right: a
 * removed field gets its stand-in row put back where it stood, an added one
 * gets the whole-row highlight, and a reordering costs nothing because key
 * pairing never looked at position. The fourth is wrong. One field removed and
 * another added leaves `matchByKey` with one candidate on each side, and
 * `matchByWords` pairs one against one on position alone — rightly, for prose,
 * where T-211 established that a unique position IS the evidence. A key is not
 * prose: it is an identifier in a namespace, and drawing `reviewer: ~` becoming
 * `approved_by: bot-one` tells the reader the two fields are related when they
 * are not. So there is no word-bag fallback here — a key on one side only is
 * one addition or one removal, and that is the whole of it.
 *
 * The columns pair by position because there is nothing else they could do: a
 * frontmatter is two columns wide by construction, so `columns.oldOnly` is
 * always empty and the removed-column path is unreachable — which is just as
 * well, since it assumes a header exists when it decides between `<th>` and
 * `<td>`.
 */
export function alignFrontmatter(
  old: TableMatrix,
  nu: TableMatrix,
): TableAlignment {
  const olds = keysOf(old);
  const news = keysOf(nu);
  const pairs = matchByKey(olds, news);
  const takenOld = new Set(pairs.map(([i]) => i));
  const takenNew = new Set(pairs.map(([, j]) => j));
  return {
    columns: {
      pairs: [
        [0, 0],
        [1, 1],
      ],
      oldOnly: [],
      newOnly: [],
    },
    rows: {
      pairs,
      oldOnly: olds.flatMap((_, i) => (takenOld.has(i) ? [] : [i])),
      newOnly: news.flatMap((_, j) => (takenNew.has(j) ? [] : [j])),
    },
  };
}
