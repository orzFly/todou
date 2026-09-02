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
};

export const NO_DECORATIONS: Decorations = {
  spans: [],
  deletions: [],
  blocks: [],
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
  return (tree: Root) => {
    if (spans.length === 0 && deletions.length === 0 && blocks.length === 0) {
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
  };
}
