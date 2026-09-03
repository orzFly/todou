import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import type { SourceRange } from "./spec-source-index.ts";

/**
 * What a decorated run of text means. `ins` is word-level diff output;
 * `comment` and `draft` are the precise slice a reviewer selected, which
 * replaces the whole-block wash the annotation used to get (T-142).
 */
export type SpanKind = "ins" | "comment" | "draft";

/** Absolute source offsets, half-open, into the markdown being rendered. */
export type SpanDecoration = {
  kind: SpanKind;
  start: number;
  end: number;
  /** The annotation this mark belongs to, so a chip can flash it. */
  key?: string;
};

/**
 * Text the new version no longer has. `at` is where it used to sit, in the
 * *new* document's coordinates — a caret, not a span. `block` marks the
 * structural case (a paragraph, a table row, a whole table went away): there
 * is no line left to strike through, so it stands on its own between the
 * blocks instead of inside one.
 */
export type DeletionDecoration = {
  at: number;
  text: string;
  block: boolean;
};

/**
 * What a paired table's new side no longer has (T-221). A removed column or
 * row has no element on the page to strike through, so one is built and put
 * back where it stood: `at` is an index into the *final* order — the new
 * table's own rows and columns with the removed ones spliced in — so applying
 * these in ascending order is what produces that order.
 */
export type TableOverlay = {
  /** The table's source range in the new document; how its `<table>` is found. */
  table: SourceRange;
  /** Removed columns, in final column order; `cells` in rendered row order. */
  columns: Array<{ at: number; cells: Array<string | null> }>;
  /** Removed rows, in final row order (0 is the header); `cells` in final column order. */
  rows: Array<{ at: number; cells: Array<string | null> }>;
  /** Cells that stayed but were emptied; the coordinates are pre-splice. */
  emptied: Array<{ row: number; col: number; text: string }>;
};

export type Decorations = {
  spans: SpanDecoration[];
  deletions: DeletionDecoration[];
  /**
   * Source ranges that are new in their entirety (T-158). The outermost
   * element inside each gets one class and keeps its children plain —
   * "which words changed" has no answer worth rendering when it is all of
   * them.
   */
  blocks: SourceRange[];
  tables: TableOverlay[];
};

export const NO_DECORATIONS: Decorations = {
  spans: [],
  deletions: [],
  blocks: [],
  tables: [],
};

/** Carries the annotation key so the popover can flash its exact mark. */
export const MARK_KEY_ATTR = "data-mark-key";

export const INS_BLOCK_CLASS = "spec-ins-block";

/**
 * Whole-block stand-ins for the marks, worn by an element whose insides
 * cannot carry one (T-164). Only code blocks need them so far.
 */
export const COMMENT_BLOCK_CLASS = "spec-mark-comment-block";
export const DRAFT_BLOCK_CLASS = "spec-mark-draft-block";

const CLASS_OF: Record<SpanKind, string> = {
  ins: "spec-ins",
  comment: "spec-mark-comment",
  draft: "spec-mark-draft",
};

const TAG_OF: Record<SpanKind, string> = {
  ins: "ins",
  comment: "mark",
  draft: "mark",
};

/** Outermost first: an inserted word that also carries a comment reads as both. */
const NESTING: SpanKind[] = ["ins", "comment", "draft"];

function wrap(
  children: ElementContent[],
  kinds: SpanKind[],
  key: string | undefined,
) {
  let content = children;
  for (const kind of [...kinds].reverse()) {
    const element: Element = {
      type: "element",
      tagName: TAG_OF[kind],
      properties: {
        className: [CLASS_OF[kind]],
        ...(key !== undefined && kind !== "ins"
          ? { [MARK_KEY_ATTR]: key }
          : {}),
      },
      children: content,
    };
    content = [element];
  }
  return content;
}

/** Spans overlapping a node's half-open source range. */
function hitsOf(
  spans: SpanDecoration[],
  from: number,
  to: number,
): SpanDecoration[] {
  return spans.filter((s) => s.start < to && s.end > from);
}

function kindsOf(hits: SpanDecoration[]): SpanKind[] {
  return NESTING.filter((k) => hits.some((h) => h.kind === k));
}

function addClass(element: Element, name: string): void {
  const existing = element.properties.className;
  element.properties.className = Array.isArray(existing)
    ? [...existing, name]
    : typeof existing === "string"
      ? [existing, name]
      : [name];
}

/** Whether an element's whole source span sits inside one of `ranges`. */
function fullyInside(element: Element, ranges: SourceRange[]): boolean {
  const start = element.position?.start.offset;
  const end = element.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  return ranges.some((range) => range.start <= start && range.end >= end);
}

function inlineDeletion(deletion: DeletionDecoration): Element {
  return {
    type: "element",
    tagName: "del",
    properties: { className: ["spec-del"], title: deletion.text },
    // Plain text on purpose: the removed source may be half a markdown
    // construct, and re-rendering it would inject stray emphasis or worse.
    children: [{ type: "text", value: deletion.text }],
  };
}

/**
 * The whole removed source, line breaks and all. Nothing in the document
 * survived to be struck through, so this marker is the only place the content
 * appears at all — a preview with the rest in a `title` (what T-209 found)
 * left a removed table showing half its header row and nothing else, and put
 * every deleted paragraph out of reach of the page's own search.
 */
function blockDeletion(deletion: DeletionDecoration): Element {
  return {
    type: "element",
    tagName: "del",
    properties: { className: ["spec-del-block"] },
    // Plain text, for `inlineDeletion`'s reason and one more: a removed table
    // row is half a construct, so re-rendering it would invent a whole table
    // around it. The CSS keeps the newlines, which is what lets the rows of a
    // removed table still read as rows.
    children: [{ type: "text", value: deletion.text.trim() }],
  };
}

export const DEL_CELL_CLASS = "spec-del-cell";
export const DEL_ROW_CLASS = "spec-del-row";

/** Element children only: the `\n` text nodes between cells are not cells. */
function elementsOf(parent: Element, tagNames: string[]): Element[] {
  return parent.children.filter(
    (child): child is Element =>
      child.type === "element" && tagNames.includes(child.tagName),
  );
}

/** Where the `n`th element child sits among all children; the end past it. */
function childIndexOf(parent: Element, n: number): number {
  let seen = 0;
  for (let i = 0; i < parent.children.length; i++) {
    if (parent.children[i]?.type !== "element") continue;
    if (seen === n) return i;
    seen++;
  }
  return parent.children.length;
}

/** The element of `tagName` whose source starts exactly at `start`, or null. */
function elementStartingAt(
  parent: Root | Element,
  tagName: string,
  start: number,
): Element | null {
  for (const child of parent.children as ElementContent[]) {
    if (child.type !== "element") continue;
    if (child.tagName === tagName && child.position?.start.offset === start) {
      return child;
    }
    // A table can sit inside a list item or a blockquote, so this recurses.
    const found = elementStartingAt(child, tagName, start);
    if (found !== null) return found;
  }
  return null;
}

/**
 * A cell the new version does not have, built to stand in the column or the
 * row it was spliced into (T-221). It carries no `position`, so `fullyInside`
 * refuses it and no "wholly new" class can land on it.
 */
function deletedCell(
  tagName: "th" | "td",
  text: string | null,
  className: string[],
): Element {
  return {
    type: "element",
    tagName,
    properties: { className },
    children:
      text === null ? [] : [inlineDeletion({ at: 0, text, block: false })],
  };
}

/**
 * Splice a paired table's removed columns and rows back into it (T-221).
 * Everything a diff draws elsewhere is a wrapper around content that is on
 * the page; a removed column has none, so this is the one place the pass adds
 * elements. It stays additive all the same: an overlay whose table cannot be
 * found is dropped in silence, exactly as a mark with no text node is.
 *
 * Order is load-bearing. `emptied` names cells by their coordinates before any
 * splice; `columns` widen every row, which is what makes a removed row's cells
 * — which already carry a slot for each removed column — line up when they are
 * inserted last.
 */
function applyOverlay(tree: Root, overlay: TableOverlay): void {
  const table = elementStartingAt(tree, "table", overlay.table.start);
  if (table === null) return;
  const head = elementsOf(table, ["thead"])[0] ?? null;
  const body = elementsOf(table, ["tbody"])[0] ?? null;
  const sections = [head, body].filter((s): s is Element => s !== null);
  const rows = sections.flatMap((section) => elementsOf(section, ["tr"]));

  for (const cell of overlay.emptied) {
    const row = rows[cell.row];
    if (row === undefined) continue;
    const target = elementsOf(row, ["th", "td"])[cell.col];
    if (target === undefined) continue;
    target.children.push(
      inlineDeletion({ at: 0, text: cell.text, block: false }),
    );
  }

  const headRows = head === null ? 0 : elementsOf(head, ["tr"]).length;
  for (const column of [...overlay.columns].sort((a, b) => a.at - b.at)) {
    rows.forEach((row, index) => {
      row.children.splice(
        childIndexOf(row, column.at),
        0,
        deletedCell(
          index < headRows ? "th" : "td",
          column.cells[index] ?? null,
          [DEL_CELL_CLASS],
        ),
      );
    });
  }

  let target = body;
  if (target === null && overlay.rows.length > 0) {
    target = {
      type: "element",
      tagName: "tbody",
      properties: {},
      children: [],
    };
    table.children.push(target);
  }
  if (target === null) return;
  for (const row of [...overlay.rows].sort((a, b) => a.at - b.at)) {
    target.children.splice(childIndexOf(target, row.at - 1), 0, {
      type: "element",
      tagName: "tr",
      properties: { className: [DEL_ROW_CLASS] },
      // The row is coloured as a row; its cells wear no class of their own.
      children: row.cells.map((text) => deletedCell("td", text, [])),
    });
  }
}

/**
 * Split one text node around the decorations that touch it. Returns null
 * when nothing applies, so untouched nodes keep their identity (T-60: a
 * rebuilt text node collapses any live selection sitting in it).
 */
function decorateText(
  node: Text,
  spans: SpanDecoration[],
  deletions: DeletionDecoration[],
  placed: Set<DeletionDecoration>,
): ElementContent[] | null {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined) return null;

  const hits = hitsOf(spans, from, to);
  const cuts = deletions.filter(
    (d) => !placed.has(d) && d.at >= from && d.at <= to,
  );
  if (hits.length === 0 && cuts.length === 0) return null;

  // Entities and escapes make the source span longer than the value, so
  // offsets inside the node mean nothing. Decorate it whole or not at all.
  if (to - from !== node.value.length) {
    if (hits.length === 0) return null;
    return wrap(
      [{ type: "text", value: node.value }],
      kindsOf(hits),
      hits.find((h) => h.key !== undefined)?.key,
    );
  }

  const points = new Set<number>([0, node.value.length]);
  for (const span of hits) {
    points.add(Math.max(0, span.start - from));
    points.add(Math.min(node.value.length, span.end - from));
  }
  for (const cut of cuts) points.add(cut.at - from);
  const ordered = [...points].sort((a, b) => a - b);

  const out: ElementContent[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const at = ordered[i];
    if (at === undefined) continue;
    for (const cut of cuts) {
      if (cut.at - from !== at || placed.has(cut)) continue;
      placed.add(cut);
      out.push(inlineDeletion(cut));
    }
    const next = ordered[i + 1];
    if (next === undefined || next <= at) continue;
    const covering = hits.filter(
      (h) => h.start - from <= at && h.end - from >= next,
    );
    const kinds = kindsOf(covering);
    const piece: Text = { type: "text", value: node.value.slice(at, next) };
    if (kinds.length === 0) out.push(piece);
    else
      out.push(
        ...wrap([piece], kinds, covering.find((h) => h.key !== undefined)?.key),
      );
  }
  return out;
}

/**
 * Decorate an element without entering it — the whole thing is marked, or
 * none of it is. Returns null when nothing applies, so untouched elements
 * keep their identity the way untouched text nodes do.
 *
 * Links take this route because their rendered contents are not their
 * source contents: `IssueLink` drops the children and renders the title it
 * fetched, so a mark painted inside is thrown away with them, and
 * `MarkdownLink` reads `node.children[0]` as a single text node to decide
 * whether a bare URL becomes a chip — a mark spliced in there quietly
 * downgrades the link (T-164). Marking part of a link would say little
 * anyway: it is one thing to click, and the anchor keeps the exact columns
 * regardless.
 */
function decorateAtomic(
  element: Element,
  spans: SpanDecoration[],
  deletions: DeletionDecoration[],
  placed: Set<DeletionDecoration>,
): ElementContent[] | null {
  const from = element.position?.start.offset;
  const to = element.position?.end.offset;
  if (from === undefined || to === undefined) return null;

  const hits = hitsOf(spans, from, to);
  // Strictly inside: a caret on either edge belongs to the neighbouring
  // text node, which claims it under the same closed interval as always.
  const cuts = deletions.filter(
    (d) => !placed.has(d) && d.at > from && d.at < to,
  );
  if (hits.length === 0 && cuts.length === 0) return null;

  const out: ElementContent[] = wrap(
    [element],
    kindsOf(hits),
    hits.find((h) => h.key !== undefined)?.key,
  );
  for (const cut of cuts) {
    placed.add(cut);
    out.push(inlineDeletion(cut));
  }
  return out;
}

/**
 * The whole-block class a `<pre>` wears when a mark reaches into it, or
 * null. pierre owns the inside of a code block (T-31), so a span crossing
 * one has no text node to land on and the block itself has to say it.
 * Insertions are already covered: a wholly-new fence gets INS_BLOCK_CLASS
 * from `blocks`, and word-level diffs only ever map onto prose.
 */
function markBlockClass(
  element: Element,
  spans: SpanDecoration[],
): string | null {
  const from = element.position?.start.offset;
  const to = element.position?.end.offset;
  if (from === undefined || to === undefined) return null;
  const kinds = kindsOf(hitsOf(spans, from, to));
  // Outermost of NESTING wins, as it would if the two could nest here.
  if (kinds.includes("comment")) return COMMENT_BLOCK_CLASS;
  return kinds.includes("draft") ? DRAFT_BLOCK_CLASS : null;
}

/**
 * Rehype plugin painting source-offset decorations onto the rendered tree
 * (T-142). Everything it does is additive: a decoration that finds no text
 * node to land on is dropped in silence, and the document then reads
 * exactly as it did before — block-level highlight and all.
 *
 * Two kinds of element are decorated whole instead of entered — code
 * blocks, whose contents belong to pierre, and links, whose contents
 * belong to `IssueLink`. `MarkdownPre` hands its text to pierre's CodeView
 * by concatenating the `<pre>`'s text children (T-31); an injected `<ins>`
 * in there would silently delete code from the display. Both still carry
 * an outer class or wrapper, which is how a mark reaching into either
 * still shows (T-164).
 */
export function rehypeDecorations(options: Decorations = NO_DECORATIONS) {
  const spans = options.spans;
  const deletions = options.deletions;
  const blocks = options.blocks;
  const tables = options.tables;
  return (tree: Root) => {
    if (
      spans.length === 0 &&
      deletions.length === 0 &&
      blocks.length === 0 &&
      tables.length === 0
    ) {
      return;
    }
    const inline = deletions.filter((d) => !d.block);
    const placed = new Set<DeletionDecoration>();

    const visit = (parent: Root | Element, insideAdded: boolean): void => {
      const next: ElementContent[] = [];
      let changed = false;
      for (const child of parent.children as ElementContent[]) {
        if (child.type === "element") {
          // The class goes on the outermost element of a wholly-new range
          // and nowhere below it, but the walk carries on regardless: an
          // annotation anchored inside still has its mark to paint.
          let added = insideAdded;
          if (!added && fullyInside(child, blocks)) {
            addClass(child, INS_BLOCK_CLASS);
            added = true;
          }
          if (child.tagName === "a") {
            const pieces = decorateAtomic(child, spans, inline, placed);
            if (pieces === null) next.push(child);
            else {
              next.push(...pieces);
              changed = true;
            }
            continue;
          }
          if (child.tagName === "pre") {
            const wash = markBlockClass(child, spans);
            if (wash !== null) addClass(child, wash);
            next.push(child);
            continue;
          }
          visit(child, added);
          next.push(child);
          continue;
        }
        if (child.type !== "text") {
          next.push(child);
          continue;
        }
        const pieces = decorateText(child, spans, inline, placed);
        if (pieces === null) next.push(child);
        else {
          next.push(...pieces);
          changed = true;
        }
      }
      if (changed) parent.children = next as typeof parent.children;
    };
    visit(tree, false);

    // Structural deletions have no host inside the text; they go between
    // the blocks, at the seam the removed content left behind. Placed back
    // to front so earlier splices don't move later insertion points.
    const structural = deletions
      .filter((d) => d.block)
      .sort((a, b) => b.at - a.at);
    for (const deletion of structural) {
      const index = (tree.children as RootContent[]).findIndex(
        (child) => (child.position?.start.offset ?? -1) >= deletion.at,
      );
      const marker = blockDeletion(deletion);
      if (index === -1) tree.children.push(marker);
      else tree.children.splice(index, 0, marker);
    }

    for (const overlay of tables) applyOverlay(tree, overlay);
  };
}
