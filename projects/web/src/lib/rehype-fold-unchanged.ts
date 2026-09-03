import type { Element, Root, RootContent } from "hast";
import { type LineRange, rangesIntersect } from "./spec-changes.ts";

/**
 * One top-level block of the rendered document, as the fold rules see it.
 * Lists, tables and blockquotes count as one block each: a `display: none`
 * `<li>` gets no counter increment, so an `<ol>` folded halfway renumbers
 * itself (T-222).
 */
export type FoldBlock = {
  /** 1-based inclusive source lines; null for a node with no position. */
  lines: LineRange | null;
  /** Intersects a changed range, or carries a diff decoration class. */
  changed: boolean;
  /** A comment or draft anchor lands in it, so a chip hangs on it. */
  annotated: boolean;
  heading: boolean;
};

/** Indices into the top-level block list, inclusive. */
export type Fold = { from: number; to: number };

export type PlanOptions = {
  /** A run shorter than this stays open. */
  minRun: number;
  /** Keep the nearest preceding heading of every changed block. */
  keepHeading: boolean;
};

/**
 * Which runs of blocks fold away. A block is kept when it changed, carries an
 * annotation, neighbours a changed block, heads the section a changed block
 * sits in, or opens or closes the document — the last so that a fold never
 * hides the title or ends the page.
 */
export function planFolds(blocks: FoldBlock[], options: PlanOptions): Fold[] {
  if (blocks.length === 0) return [];
  const keep = blocks.map((block) => block.changed || block.annotated);
  for (let i = 0; i < blocks.length; i++) {
    // The original flag, not `keep`: context around context would cascade.
    if (blocks[i]?.changed !== true) continue;
    if (i > 0) keep[i - 1] = true;
    if (i + 1 < blocks.length) keep[i + 1] = true;
    if (!options.keepHeading) continue;
    for (let above = i - 1; above >= 0; above--) {
      if (blocks[above]?.heading !== true) continue;
      keep[above] = true;
      break;
    }
  }
  keep[0] = true;
  keep[blocks.length - 1] = true;

  const folds: Fold[] = [];
  let from = -1;
  for (let i = 0; i <= blocks.length; i++) {
    if (i < blocks.length && keep[i] !== true) {
      if (from < 0) from = i;
      continue;
    }
    if (from < 0) continue;
    if (i - from >= options.minRun) folds.push({ from, to: i - 1 });
    from = -1;
  }
  return folds;
}

/**
 * Stable identity for a fold across re-renders. Source lines rather than block
 * indices, so the placeholders the reader opened stay open while an annotation
 * elsewhere adds or removes a block.
 */
export function foldKey(fold: Fold, blocks: FoldBlock[]): string {
  let start: number | undefined;
  let end: number | undefined;
  for (let i = fold.from; i <= fold.to; i++) {
    const lines = blocks[i]?.lines;
    if (lines === null || lines === undefined) continue;
    start ??= lines.start;
    end = lines.end;
  }
  return start === undefined || end === undefined
    ? `i${fold.from}-${fold.to}`
    : `${start}-${end}`;
}

export type FoldOptions = {
  changedRanges: LineRange[];
  annotationRanges: LineRange[];
  /** Fold keys the reader opened. */
  expanded: ReadonlySet<string>;
  keepHeading: boolean;
};

export const FOLD_CLASS = "spec-fold";
export const FOLDED_CLASS = "spec-folded";
export const FOLD_KEY_ATTR = "data-fold-key";

/**
 * Everything rehype-decorations paints. Reading the classes rather than the
 * ranges is what keeps a mark from being folded away: an aligned pair puts
 * marks on lines the line diff never reported, and the deletion markers have
 * no source position at all.
 */
const DECORATION_CLASSES = new Set([
  "spec-ins-block",
  "spec-del-block",
  "spec-ins",
  "spec-del",
]);

function classesOf(element: Element): string[] {
  // `unknown`, because hast types the property as an array while a plugin is
  // free to leave a plain string there.
  const value: unknown = element.properties.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value.split(/\s+/) : [];
}

function addClass(element: Element, name: string): void {
  element.properties.className = [...classesOf(element), name];
}

function carriesDecoration(node: RootContent): boolean {
  if (node.type !== "element") return false;
  if (classesOf(node).some((name) => DECORATION_CLASSES.has(name))) return true;
  return node.children.some(carriesDecoration);
}

function blockOf(element: Element, options: FoldOptions): FoldBlock {
  const start = element.position?.start.line;
  const end = element.position?.end.line;
  const lines =
    start === undefined || end === undefined ? null : { start, end };
  const hits = (ranges: LineRange[]) =>
    lines !== null && ranges.some((range) => rangesIntersect(range, lines));
  return {
    lines,
    changed: hits(options.changedRanges) || carriesDecoration(element),
    annotated: hits(options.annotationRanges),
    heading: /^h[1-6]$/.test(element.tagName),
  };
}

function placeholder(key: string, count: number): Element {
  return {
    type: "element",
    tagName: "button",
    properties: {
      type: "button",
      className: [FOLD_CLASS],
      [FOLD_KEY_ATTR]: key,
      "aria-label": `Show ${count} unchanged blocks`,
    },
    children: [{ type: "text", value: `${count} unchanged blocks` }],
  };
}

/**
 * Hides the runs of top-level blocks that carry nothing to review, each behind
 * a placeholder button the reader can open. Runs after rehypeDecorations,
 * whose classes it reads, and only when the caller has a comparison with
 * changes to show: with nothing marked anywhere, every rule but "keep the
 * first and last block" falls silent and the whole document folds into one
 * placeholder.
 */
export function rehypeFoldUnchanged(options: FoldOptions) {
  return (tree: Root) => {
    const positions: number[] = [];
    const blocks: FoldBlock[] = [];
    tree.children.forEach((child, index) => {
      if (child.type !== "element") return;
      positions.push(index);
      blocks.push(blockOf(child, options));
    });

    const folds = planFolds(blocks, {
      minRun: 2,
      keepHeading: options.keepHeading,
    }).filter((fold) => !options.expanded.has(foldKey(fold, blocks)));

    // Back to front: an earlier splice would move every later block index.
    for (const fold of folds.reverse()) {
      for (let i = fold.from; i <= fold.to; i++) {
        const at = positions[i];
        const node = at === undefined ? undefined : tree.children[at];
        if (node?.type === "element") addClass(node, FOLDED_CLASS);
      }
      const first = positions[fold.from];
      if (first === undefined) continue;
      const key = foldKey(fold, blocks);
      tree.children.splice(first, 0, placeholder(key, fold.to - fold.from + 1));
    }
  };
}
