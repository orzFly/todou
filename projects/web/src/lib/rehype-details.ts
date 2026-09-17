import type { Element, ElementContent, Root, RootContent } from "hast";
import {
  type ReviewInterestOptions,
  reviewInterestOf,
} from "./rehype-fold-unchanged.ts";

/** unist's point type, without adding a dependency on it. */
type Point = NonNullable<Element["position"]>["start"];

/** Raw HTML as `mdast-util-to-hast` leaves it, before react-markdown escapes it. */
type Raw = Extract<RootContent, { type: "raw" }>;

/**
 * HTML whitespace, spelled out instead of `\s`: that class also matches NBSP
 * and the Unicode space separators, and every character this recogniser
 * accepts has to be one a reviewer can read off the grammar.
 */
const S = "[ \\t\\n\\f\\r]";

/**
 * The five literals the recogniser knows, and the whole of what it knows.
 * Everything else — `<details class="x">`, `<details open="open">`,
 * `<details/>`, `<detailsfoo>`, `< details>` — falls through untouched and
 * reaches the reader as escaped source, which is what raw HTML has always
 * done here.
 *
 * Alternatives rather than one pattern with an optional attribute, so that
 * `open` is decided by *which literal matched* and never by reading the
 * match: see `foldElement`.
 */
const MARKER = new RegExp(
  [
    `(?<detailsOpen><details${S}*>)`,
    `(?<detailsOpenExpanded><details${S}+open${S}*>)`,
    `(?<detailsClose></details${S}*>)`,
    `(?<summaryOpen><summary${S}*>)`,
    `(?<summaryClose></summary${S}*>)`,
  ].join("|"),
  "gi",
);

type MarkerKind =
  | "details-open"
  | "details-close"
  | "summary-open"
  | "summary-close";

type Marker = {
  marker: MarkerKind;
  /** The literal that matched was the `<details open>` one. */
  open: boolean;
  /** What this marker turns back into when nothing pairs with it. */
  source: Raw;
};

/** A child of the node being rewritten, or a literal waiting to be paired. */
type Piece = Marker | ElementContent;

function isMarker(piece: Piece): piece is Marker {
  return "marker" in piece;
}

/**
 * The only path from a recognised literal to an element. Its arguments are the
 * two constants the recogniser chose between; the matched source is not one of
 * them and cannot be reached from in here. That is what makes "no byte of the
 * document ever becomes an attribute value" a property of this signature
 * rather than of how tightly the regex above is written — a regex loose enough
 * to accept `<details onclick=x>` would still produce nothing but an empty
 * `<details>`.
 */
function foldElement(tagName: "details" | "summary", open: boolean): Element {
  return {
    type: "element",
    tagName,
    properties: open ? { open: true } : {},
    children: [],
  };
}

/**
 * Where `consumed` ends, counted from `start`. Lines come out exact wherever
 * this is used, because a raw node's value holds one newline per source line
 * it spans; columns and offsets are short by whatever a container strips off
 * the front of each line (`> ` in a blockquote), and the fold, stamp and
 * decoration passes all read lines.
 */
function advance(start: Point, consumed: string): Point {
  const lines = consumed.split("\n");
  const breaks = lines.length - 1;
  return {
    line: start.line + breaks,
    column:
      breaks === 0
        ? start.column + consumed.length
        : (lines[breaks]?.length ?? 0) + 1,
    offset:
      start.offset === undefined ? undefined : start.offset + consumed.length,
  };
}

function rawAt(value: string, start: Point | undefined): Raw {
  if (start === undefined) return { type: "raw", value };
  return {
    type: "raw",
    value,
    position: { start, end: advance(start, value) },
  };
}

function kindOf(groups: Record<string, string | undefined>): MarkerKind {
  if (groups.detailsClose !== undefined) return "details-close";
  if (groups.summaryOpen !== undefined) return "summary-open";
  if (groups.summaryClose !== undefined) return "summary-close";
  return "details-open";
}

/**
 * One raw node cut into the literals it holds and the text between them, or
 * null when it holds none — a node nothing matched keeps its identity, which
 * is the same rule `MarkdownView` follows for its component map (T-60).
 *
 * Matching starts anywhere inside the value rather than at its front: a single
 * raw node routinely carries a whole block of HTML, and
 * `<details><summary>t</summary><script>alert(1)</script></details>` has to
 * come apart into two elements and one string of escaped source.
 */
function splitRaw(node: Raw): Piece[] | null {
  MARKER.lastIndex = 0;
  let match = MARKER.exec(node.value);
  if (match === null) return null;
  const start = node.position?.start;
  const pointAt = (index: number): Point | undefined =>
    start === undefined
      ? undefined
      : index === 0
        ? start
        : advance(start, node.value.slice(0, index));
  const pieces: Piece[] = [];
  let consumed = 0;
  while (match !== null) {
    if (match.index > consumed) {
      pieces.push(
        rawAt(node.value.slice(consumed, match.index), pointAt(consumed)),
      );
    }
    const groups = match.groups ?? {};
    const whole =
      match.index === 0 && match[0].length === node.value.length ? node : null;
    pieces.push({
      marker: kindOf(groups),
      open: groups.detailsOpenExpanded !== undefined,
      source: whole ?? rawAt(match[0], pointAt(match.index)),
    });
    consumed = match.index + match[0].length;
    match = MARKER.exec(node.value);
  }
  if (consumed < node.value.length) {
    pieces.push(rawAt(node.value.slice(consumed), pointAt(consumed)));
  }
  return pieces;
}

/** Every marker nothing paired with goes back to being raw, i.e. to source text. */
function resolve(pieces: Piece[]): ElementContent[] {
  return pieces.map((piece) => (isMarker(piece) ? piece.source : piece));
}

function spanning(open: Raw, close: Raw): Element["position"] {
  const start = open.position?.start;
  const end = close.position?.end;
  return start === undefined || end === undefined ? undefined : { start, end };
}

/** The `details-close` that matches the open marker at `from`; -1 for none. */
function matchingClose(pieces: Piece[], from: number): number {
  let depth = 0;
  for (let i = from + 1; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === undefined || !isMarker(piece)) continue;
    if (piece.marker === "details-open") depth++;
    else if (piece.marker === "details-close") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * The first `<summary>…</summary>` of a fold, as its own element. A second one
 * in the same fold, and any that sits outside a fold altogether, keeps its
 * markers and so reaches the reader as source — without this pass, a rejected
 * `<details onclick=x>` would leave its `<summary>` behind as a stray element
 * floating in the document, which is the one place "a rejected tag shows up
 * whole, as text" would otherwise have an exception.
 */
function pairSummary(pieces: Piece[]): Piece[] {
  const open = pieces.findIndex(
    (piece) => isMarker(piece) && piece.marker === "summary-open",
  );
  if (open < 0) return pieces;
  const close = pieces.findIndex(
    (piece, i) =>
      i > open && isMarker(piece) && piece.marker === "summary-close",
  );
  if (close < 0) return pieces;
  const openMarker = pieces[open];
  const closeMarker = pieces[close];
  if (
    openMarker === undefined ||
    closeMarker === undefined ||
    !isMarker(openMarker) ||
    !isMarker(closeMarker)
  ) {
    return pieces;
  }
  const element = foldElement("summary", false);
  element.children = resolve(pieces.slice(open + 1, close));
  element.position = spanning(openMarker.source, closeMarker.source);
  return [...pieces.slice(0, open), element, ...pieces.slice(close + 1)];
}

/**
 * Pair the `details` literals of one children array, innermost pairs last.
 * A marker whose partner sits in another parent — `<details>` opened in a list
 * item and closed at the top level — finds nothing here and stays source.
 */
function pairDetails(pieces: Piece[], made: Set<Element>): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === undefined) continue;
    if (!isMarker(piece) || piece.marker !== "details-open") {
      out.push(piece);
      continue;
    }
    const close = matchingClose(pieces, i);
    const closeMarker = close < 0 ? undefined : pieces[close];
    if (closeMarker === undefined || !isMarker(closeMarker)) {
      out.push(piece);
      continue;
    }
    const element = foldElement("details", piece.open);
    element.children = resolve(
      pairSummary(pairDetails(pieces.slice(i + 1, close), made)),
    );
    element.position = spanning(piece.source, closeMarker.source);
    made.add(element);
    out.push(element);
    i = close;
  }
  return out;
}

/**
 * Where a fold may be recognised. `p` and the phrasing elements are absent on
 * purpose: HTML forbids `<details>` inside `<p>`, and CommonMark gives only
 * the block form a node of its own, so `a <details>b</details> c` is a line
 * whose author meant those characters.
 */
const FLOW_PARENTS = new Set(["blockquote", "li", "td", "th"]);

/**
 * Cut exactly two tags out of the escaping that raw HTML otherwise gets.
 *
 * react-markdown replaces every `raw` node with a text node holding its
 * source, which is why an unsupported tag reaches the reader as the characters
 * they typed. This plugin runs in the window before that, turns the literals
 * of `MARKER` into elements it builds from constants, and leaves every other
 * `raw` node exactly where it was — so the set of elements the document can
 * hold grows by `details` and `summary` and by nothing else.
 */
export function rehypeDetails() {
  return (tree: Root) => {
    const made = new Set<Element>();
    const visit = (parent: Root | Element, recognise: boolean): void => {
      if (recognise) {
        const pieces: Piece[] = [];
        let cut = false;
        for (const child of parent.children as ElementContent[]) {
          const parts = child.type === "raw" ? splitRaw(child) : null;
          if (parts === null) {
            pieces.push(child);
            continue;
          }
          pieces.push(...parts);
          cut = true;
        }
        if (cut) {
          parent.children = resolve(
            pairDetails(pieces, made),
          ) as typeof parent.children;
        }
      }
      for (const child of parent.children) {
        if (child.type !== "element") continue;
        // A fold this pass built has had its own children paired already, and
        // re-reading them would let a rejected literal that is now plain text
        // pair with something it never stood beside.
        visit(child, !made.has(child) && FLOW_PARENTS.has(child.tagName));
      }
    };
    visit(tree, true);
  };
}

/**
 * Open the folds a reviewer has something to look at inside. A closed
 * `<details>` renders its contents `display: none`, which takes the diff
 * highlight, the annotation anchors and every rect the chip layout measures
 * with it.
 *
 * Runs after `rehypeDecorations`, whose classes are half of what
 * `reviewInterestOf` reads, and before `rehypeFoldUnchanged`, which has to see
 * a fold that already knows whether it is open.
 */
export function rehypeExpandDetails(options: ReviewInterestOptions) {
  return (tree: Root) => {
    const visit = (parent: Root | Element): void => {
      for (const child of parent.children) {
        if (child.type !== "element") continue;
        if (child.tagName === "details") {
          const interest = reviewInterestOf(child, options);
          if (interest.changed || interest.annotated) {
            child.properties.open = true;
          }
        }
        visit(child);
      }
    };
    visit(tree);
  };
}
