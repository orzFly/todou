import type { Element, ElementContent, Root, RootContent, Text } from "hast";

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
 * structural case (a whole paragraph or table row went away): there is no
 * sensible line to strike through, so it degrades to a small marker.
 */
export type DeletionDecoration = {
  at: number;
  text: string;
  block: boolean;
};

export type Decorations = {
  spans: SpanDecoration[];
  deletions: DeletionDecoration[];
};

export const NO_DECORATIONS: Decorations = { spans: [], deletions: [] };

/** Carries the annotation key so the popover can flash its exact mark. */
export const MARK_KEY_ATTR = "data-mark-key";

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

/** How much of a structural deletion the marker shows before its tooltip. */
const BLOCK_PREVIEW = 48;

function wrap(value: string, kinds: SpanKind[], key: string | undefined) {
  let content: ElementContent[] = [{ type: "text", value }];
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

function blockDeletion(deletion: DeletionDecoration): Element {
  const flat = deletion.text.replace(/\s+/g, " ").trim();
  const preview =
    flat.length > BLOCK_PREVIEW ? `${flat.slice(0, BLOCK_PREVIEW)}…` : flat;
  return {
    type: "element",
    tagName: "del",
    properties: { className: ["spec-del-block"], title: deletion.text },
    children: [{ type: "text", value: preview }],
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

  const hits = spans.filter((s) => s.start < to && s.end > from);
  const cuts = deletions.filter(
    (d) => !placed.has(d) && d.at >= from && d.at <= to,
  );
  if (hits.length === 0 && cuts.length === 0) return null;

  // Entities and escapes make the source span longer than the value, so
  // offsets inside the node mean nothing. Decorate it whole or not at all.
  if (to - from !== node.value.length) {
    if (hits.length === 0) return null;
    const kinds = NESTING.filter((k) => hits.some((h) => h.kind === k));
    return wrap(node.value, kinds, hits.find((h) => h.key !== undefined)?.key);
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
    const kinds = NESTING.filter((k) => covering.some((h) => h.kind === k));
    const piece = node.value.slice(at, next);
    if (kinds.length === 0) out.push({ type: "text", value: piece });
    else
      out.push(
        ...wrap(piece, kinds, covering.find((h) => h.key !== undefined)?.key),
      );
  }
  return out;
}

/**
 * Rehype plugin painting source-offset decorations onto the rendered tree
 * (T-142). Everything it does is additive: a decoration that finds no text
 * node to land on is dropped in silence, and the document then reads
 * exactly as it did before — block-level highlight and all.
 *
 * Code blocks are skipped whole. `MarkdownPre` hands their text to pierre's
 * CodeView by concatenating the `<pre>`'s text children (T-31); an injected
 * `<ins>` in there would silently delete code from the display.
 */
export function rehypeDecorations(options: Decorations = NO_DECORATIONS) {
  const spans = options.spans;
  const deletions = options.deletions;
  return (tree: Root) => {
    if (spans.length === 0 && deletions.length === 0) return;
    const inline = deletions.filter((d) => !d.block);
    const placed = new Set<DeletionDecoration>();

    const visit = (parent: Root | Element): void => {
      const next: ElementContent[] = [];
      let changed = false;
      for (const child of parent.children as ElementContent[]) {
        if (child.type === "element") {
          if (child.tagName !== "pre") visit(child);
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
    visit(tree);

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
