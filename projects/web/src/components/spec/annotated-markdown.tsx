import { formatAnchorRange, type SpecCommentItem } from "@todou/shared";
import {
  CheckIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type Markdown from "react-markdown";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  INS_BLOCK_CLASS,
  MARK_KEY_ATTR,
  NO_DECORATIONS,
  rehypeDecorations,
} from "@/lib/rehype-decorations.ts";
import { rehypeExpandDetails } from "@/lib/rehype-details.ts";
import {
  FOLD_CLASS,
  FOLD_KEY_ATTR,
  rehypeFoldUnchanged,
} from "@/lib/rehype-fold-unchanged.ts";
import {
  CODE_CONTENT_START_ATTR,
  parseSourceLoc,
  rehypeSourceLines,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import { revealBlock } from "@/lib/scroll-insets.ts";
import { type LineRange, rangesIntersect } from "@/lib/spec-changes.ts";
import {
  annotationDecorations,
  changeDecorations,
  mergeDecorations,
  pairedFences,
} from "@/lib/spec-decorations.ts";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";
import {
  buildSegmentIndex,
  lineColAt,
  type SegmentIndex,
  segmentsInLines,
  sourceOffsetOfRendered,
} from "@/lib/spec-source-index.ts";
import { POINTER_FINE, useMediaQuery } from "@/lib/use-media-query.ts";

type RehypePlugins = ComponentProps<typeof Markdown>["rehypePlugins"];

// Stable array — MarkdownView passes it straight to react-markdown.
const REHYPE_PLUGINS: RehypePlugins = [rehypeSourceLines];

// Stable empty defaults, for the same reason as the array above: a fresh `[]`
// on every render invalidates the memo the plugin array hangs on.
const NO_RANGES: LineRange[] = [];
const NO_FOLDS: ReadonlySet<string> = new Set();

export type DisplayedAnnotation = {
  key: string;
  /** 1-based inclusive lines in the *viewed* version. */
  start: number;
  end: number;
  /** 1-based inclusive columns within those lines; null = whole lines. */
  colStart?: number | null;
  colEnd?: number | null;
} & (
  | { kind: "comment"; item: SpecCommentItem }
  | { kind: "draft"; draft: SpecReviewDraft }
);

type Chip = {
  blockKey: string;
  top: number;
  items: DisplayedAnnotation[];
};

/** Where an annotation sits, as displayed on the version being viewed. */
function labelOf(item: DisplayedAnnotation): string {
  return formatAnchorRange({
    line_start: item.start,
    line_end: item.end,
    col_start: item.colStart,
    col_end: item.colEnd,
  });
}

export type AnchorRange = {
  lineStart: number;
  lineEnd: number;
  colStart: number | null;
  colEnd: number | null;
};

type PendingSelection = AnchorRange & { top: number };

/**
 * How long a press on the entry keeps its anchor alive without a `click` to
 * close the window. Long enough for a touch's own click to arrive, short
 * enough that a press which slid off the entry does not strand a dead
 * anchor on screen.
 */
const PRESS_WINDOW_MS = 300;

/** The element a node is, or the one holding it. */
function elementNear(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/**
 * The block a selection endpoint sits in, when that block can carry column
 * precision. Code blocks are excluded on purpose: their text reaches the
 * DOM through pierre's own renderer (T-31/T-52), so DOM offsets there say
 * nothing about the markdown source and the anchor stays line-level.
 */
function columnBlockOf(
  node: Node,
): { el: Element; loc: { start: number; end: number } } | null {
  const stamped = elementNear(node)?.closest(`[${SOURCE_LINE_ATTR}]`) ?? null;
  if (stamped === null) return null;
  if (stamped.hasAttribute(CODE_CONTENT_START_ATTR)) return null;
  const loc = parseSourceLoc(stamped.getAttribute(SOURCE_LINE_ATTR));
  return loc === null ? null : { el: stamped, loc };
}

/**
 * Text nodes of a block as the *document* has them — the annotation UI and
 * the `<del>` runs this component injects are not part of the source and
 * would shift every offset after them.
 */
function sourceTextWalker(block: Element): TreeWalker {
  return document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (node.nodeType !== Node.ELEMENT_NODE)
          return NodeFilter.FILTER_ACCEPT;
        const el = node as Element;
        return el.hasAttribute("data-annotation-ui") ||
          el.classList.contains("spec-del") ||
          el.classList.contains("spec-del-block")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
}

function renderedTextOf(block: Element): string {
  const walker = sourceTextWalker(block);
  let text = "";
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    text += n.nodeValue ?? "";
  }
  return text;
}

/** Offset of a text-node position within the block's rendered text. */
function renderedOffsetIn(
  block: Element,
  node: Node,
  offset: number,
): number | null {
  const walker = sourceTextWalker(block);
  let seen = 0;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n === node) return seen + offset;
    seen += n.nodeValue?.length ?? 0;
  }
  return null;
}

/** Source offset one selection endpoint maps to, or null to give up. */
function sourceOffsetOfEndpoint(
  index: SegmentIndex,
  node: Node,
  offset: number,
  edge: "start" | "end",
): number | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const block = columnBlockOf(node);
  if (block === null) return null;
  const segments = segmentsInLines(index, block.loc);
  if (segments.length === 0) return null;
  // The mapping assumes the block renders its source prose and nothing
  // else. An attachment card or any other injected text breaks that, and
  // a wrong column is worse than none — bail out to the line anchor.
  if (renderedTextOf(block.el) !== segments.map((s) => s.text).join("")) {
    return null;
  }
  const rendered = renderedOffsetIn(block.el, node, offset);
  if (rendered === null) return null;
  return sourceOffsetOfRendered(segments, rendered, edge);
}

/**
 * Narrow a selection to source columns (T-142). Returns null whenever the
 * mapping is not provably right, and the caller keeps the whole-block line
 * anchor that spec review has always produced.
 */
export function columnsOfSelection(
  index: SegmentIndex,
  range: Range,
): AnchorRange | null {
  const start = sourceOffsetOfEndpoint(
    index,
    range.startContainer,
    range.startOffset,
    "start",
  );
  const end = sourceOffsetOfEndpoint(
    index,
    range.endContainer,
    range.endOffset,
    "end",
  );
  if (start === null || end === null || end <= start) return null;
  // Columns name a real character, inclusively (the contract lives in
  // shared/schemas/spec.ts), so `len + 1` is never one — the server measures
  // lines without their newline. Both ends therefore step off a newline they
  // landed on, which makes a selection starting at a line end mean column 1
  // of the next line rather than one past the end of this one.
  let first = start;
  let last = end - 1;
  while (first < last && index.source[first] === "\n") first++;
  while (last > first && index.source[last] === "\n") last--;
  // Newlines only: no column can name that, so the whole-line anchor stands.
  if (index.source[first] === "\n") return null;
  const from = lineColAt(index, first);
  const to = lineColAt(index, last);
  if (to.line < from.line || (to.line === from.line && to.col < from.col)) {
    return null;
  }
  return {
    lineStart: from.line,
    lineEnd: to.line,
    colStart: from.col,
    colEnd: to.col,
  };
}

/** Which side of a diff one of pierre's line rows numbers itself on. */
const LINE_TYPE_ATTR = "data-line-type";
const DELETION_LINE_TYPE = "change-deletion";

/**
 * Source-line range for the block a selection endpoint sits in (T-52).
 * pierre renders code blocks inside an open shadow root, so the walk hops
 * shadow boundaries host by host until a stamped ancestor appears. When
 * the endpoint is on one of pierre's line rows (`data-line`, 1-based
 * within the code contents), the whole-block range narrows down to that
 * exact source line via the stamped content start.
 */
export function anchorRangeForNode(
  node: Node,
): { start: number; end: number } | null {
  let el = elementNear(node);
  let row: Element | null = null;
  while (el !== null) {
    row ??= el.closest("[data-line]");
    const stamped = el.closest(`[${SOURCE_LINE_ATTR}]`);
    if (stamped !== null) {
      const loc = parseSourceLoc(stamped.getAttribute(SOURCE_LINE_ATTR));
      if (loc === null) return null;
      if (row !== null) {
        // A deletion row numbers itself on the OLD side, so the current
        // source has no line for it and `contentStart + rowLine - 1` names
        // an unrelated one — silently, and plausibly (T-343). The whole
        // block is the honest answer; the other three line types pierre
        // emits, `context-expanded` included, all number the new side and
        // go down the formula below.
        if (row.getAttribute(LINE_TYPE_ATTR) === DELETION_LINE_TYPE) return loc;
        const contentStart = Number(
          stamped.getAttribute(CODE_CONTENT_START_ATTR),
        );
        const rowLine = Number(row.getAttribute("data-line"));
        if (
          Number.isInteger(contentStart) &&
          Number.isInteger(rowLine) &&
          rowLine >= 1
        ) {
          // Clamp: an unclosed fence can stamp an end before start+rows.
          const line = Math.min(contentStart + rowLine - 1, loc.end);
          return { start: line, end: line };
        }
      }
      return loc;
    }
    const root = el.getRootNode();
    el = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** `container.contains` that sees through open shadow roots. */
function composedContains(container: Element, node: Node): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (container.contains(current)) return true;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

/** Every open shadow root under `root`, nested ones included. */
function openShadowRoots(root: Element | ShadowRoot): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot === null) continue;
    found.push(el.shadowRoot, ...openShadowRoots(el.shadowRoot));
  }
  return found;
}

export type SelectionEndpoints = {
  start: { node: Node; offset: number };
  end: { node: Node; offset: number };
  collapsed: boolean;
};

/**
 * Both ends of a selection, seen through open shadow roots (T-164). pierre
 * renders code inside one, and the legacy endpoints misreport anything that
 * lands in there: dragging from prose *into* a code line puts the focus on
 * the shadow host, which costs the anchor its line precision, and dragging
 * the other way collapses the whole selection to one empty div — while
 * `toString()` still returns the selected code. The collapse is why a
 * backwards drag out of a fence offered no comment button at all.
 *
 * `getComposedRanges` answers with the real endpoints. Where it does not
 * exist (jsdom, older browsers) the legacy ones stand exactly as before.
 */
export function selectionEndpoints(
  selection: Selection,
  container: Element,
): SelectionEndpoints | null {
  if (typeof selection.getComposedRanges === "function") {
    const composed = selection.getComposedRanges({
      shadowRoots: openShadowRoots(container),
    })[0];
    if (composed !== undefined) {
      return {
        start: { node: composed.startContainer, offset: composed.startOffset },
        end: { node: composed.endContainer, offset: composed.endOffset },
        collapsed: composed.collapsed,
      };
    }
  }
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return {
    start: {
      node: selection.anchorNode ?? range.startContainer,
      offset: selection.anchorOffset,
    },
    end: {
      node: selection.focusNode ?? range.endContainer,
      offset: selection.focusOffset,
    },
    collapsed: selection.isCollapsed,
  };
}

/** Where an endpoint falls relative to the rendered file. */
type Side = "inside" | "before" | "after";

function sideOf(container: Element, node: Node, offset: number): Side | null {
  // Containment is settled first: a node inside pierre's shadow root has no
  // position relative to the container at all, and comparing it would answer
  // about the host's siblings instead (T-164).
  if (composedContains(container, node)) return "inside";
  const span = document.createRange();
  span.selectNode(container);
  try {
    const where = span.comparePoint(node, offset);
    return where < 0 ? "before" : where > 0 ? "after" : "inside";
  } catch {
    return null;
  }
}

/**
 * The endpoints as a forward range, or null when they cannot make one.
 *
 * Endpoints arrive in whatever order the user dragged, and `setEnd` before
 * the start silently collapses the range onto that point rather than
 * complaining — so a collapsed result is the signal to try the other way
 * round. Ends in two different trees collapse both ways, which is the null.
 */
function orderedRange(ends: SelectionEndpoints): Range | null {
  const forward = document.createRange();
  forward.setStart(ends.start.node, ends.start.offset);
  forward.setEnd(ends.end.node, ends.end.offset);
  if (!forward.collapsed) return forward;
  const backward = document.createRange();
  backward.setStart(ends.end.node, ends.end.offset);
  backward.setEnd(ends.start.node, ends.start.offset);
  return backward.collapsed ? null : backward;
}

/** The block one endpoint anchors to, clamped to the container's edges. */
function blockOfEndpoint(
  node: Node,
  side: Side,
  blocks: Element[],
): { start: number; end: number } | null {
  if (side === "inside") return anchorRangeForNode(node);
  const edge = side === "before" ? blocks[0] : blocks[blocks.length - 1];
  return edge === undefined
    ? null
    : parseSourceLoc(edge.getAttribute(SOURCE_LINE_ATTR));
}

/**
 * The anchor a selection points at, or null when it points at nothing in
 * this file. Endpoints outside the container are clamped to its first or
 * last block instead of forfeiting the anchor: a drag that overshoots the
 * end of the prose, or ⌘/Ctrl-A, still means "this file, from here to
 * there". Only a selection lying wholly on one side of the container has
 * nothing to say about it.
 *
 * Fed endpoints rather than a Selection so that the decision is a value
 * computation: no DOM events, no React, and tests can hand it a pair of
 * nodes.
 */
export function anchorForSelection(
  container: Element,
  index: SegmentIndex,
  ends: SelectionEndpoints,
): AnchorRange | null {
  const startSide = sideOf(container, ends.start.node, ends.start.offset);
  const endSide = sideOf(container, ends.end.node, ends.end.offset);
  if (startSide === null || endSide === null) return null;
  if (startSide === endSide && startSide !== "inside") return null;
  const blocks = [...container.querySelectorAll(`[${SOURCE_LINE_ATTR}]`)];
  const from = blockOfEndpoint(ends.start.node, startSide, blocks);
  const to = blockOfEndpoint(ends.end.node, endSide, blocks);
  if (from === null || to === null) return null;
  // A clamped endpoint names a block, not a character in it, so columns are
  // only ever narrowed while both ends are in the rendered file.
  const range =
    startSide === "inside" && endSide === "inside" ? orderedRange(ends) : null;
  const columns = range === null ? null : columnsOfSelection(index, range);
  // Direction doesn't matter to the lines; the min/max absorbs it.
  return (
    columns ?? {
      lineStart: Math.min(from.start, to.start),
      lineEnd: Math.max(from.end, to.end),
      colStart: null,
      colEnd: null,
    }
  );
}

/**
 * Innermost block whose source range contains `line`. Stamped blocks nest
 * — a table and its rows, a blockquote and its paragraphs — and document
 * order puts the ancestor first, so the last match is the deepest one
 * (T-142). Lines that fall in a gap keep the old behaviour of attaching to
 * the block above.
 */
export function blockForLine(
  blocks: Array<{ start: number; end: number }>,
  line: number,
): number {
  let found = -1;
  let fallback = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (line >= block.start && line <= block.end) found = i;
    else if (block.start <= line) fallback = i;
  }
  return found >= 0 ? found : fallback;
}

/**
 * A block's top within the annotation container. `offsetTop` agrees for a
 * paragraph but lies for a `<tr>`: HTML cuts the offsetParent chain at
 * table/td/th, so a row reports its offset inside its own table — 36px for
 * a row sitting 581px down the page. Rects have no such blind spot, and the
 * two of them move together under scroll.
 */
export function chipTop(containerRect: { top: number }, el: Element): number {
  return el.getBoundingClientRect().top - containerRect.top;
}

/**
 * The outermost fold standing between `el` and the reader, or `el` itself.
 *
 * A closed `<details>` renders its contents `display: none`, and every rect
 * inside one is zero, so measuring the block directly stacks its chip at the
 * top of the container. The fold pass never has this problem because it
 * refuses to fold an annotated block at all — but a `<details>` is the
 * reader's to close, so the chip follows it up to the fold's own header
 * instead. Asking which fold is shut says the reason, and needs no layout.
 *
 * One pass up the ancestor chain, keeping the last match, rather than a
 * `closest` that restarts from what it found: the walk then terminates
 * because the DOM is finite, and a future edit cannot turn it into the
 * synchronous spin that a test runner has no way to interrupt or name.
 */
export function visibleAnchor(el: HTMLElement): HTMLElement {
  let anchor = el;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (node.matches("details:not([open])")) anchor = node;
  }
  return anchor;
}

/**
 * Where the floating entry sits, in container coordinates.
 *
 * The legacy range is what has a rect — but when the browser clamped it
 * onto a shadow host it is an empty box there, and the endpoint's own
 * element is then what says where to sit (T-164).
 */
function entryTop(
  container: Element,
  selection: Selection,
  ends: SelectionEndpoints,
): number {
  const legacy = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const rect =
    (legacy === null || legacy.collapsed
      ? elementNear(ends.end.node)?.getBoundingClientRect()
      : null) ?? legacy?.getBoundingClientRect();
  return (rect?.bottom ?? 0) - container.getBoundingClientRect().top + 6;
}

/**
 * Rendered markdown with the annotation layer of the spec review view:
 * selecting text floats a "comment" button (the anchor is derived from the
 * blocks' stamped source lines), staged drafts and submitted comments hang
 * as chips on their blocks, and each chip opens the thread in a popover.
 */
export function AnnotatedMarkdown({
  slug,
  issueNumber,
  body,
  baselineBody,
  annotations,
  changedRanges = NO_RANGES,
  foldUnchanged = false,
  onStage,
  onEditDraft,
  onRemoveDraft,
  onResolve,
  resolving = false,
}: {
  slug: string;
  issueNumber: number;
  body: string;
  /**
   * The same file in the compare baseline, when "changes since vN" is on.
   * Its presence is what turns the word-level diff on (T-142); leaving it
   * out renders the document with annotations only.
   */
  baselineBody?: string;
  /** The viewed spec version's push time (T-80 time cutoff). */
  annotations: DisplayedAnnotation[];
  /** Lines changed since the compare baseline — green highlight + ↑↓ nav. */
  changedRanges?: LineRange[];
  /**
   * Fold the runs of blocks that carry nothing to review (T-222). Only ever
   * true for a rendered comparison of a file that has changes to fold around;
   * spec-view owns that judgement, and the reader's preference.
   */
  foldUnchanged?: boolean;
  /** Stage a draft for the selected source range of the viewed version. */
  onStage: (range: AnchorRange) => void;
  /** Load a staged draft back into the composer for rewriting (T-159). */
  onEditDraft: (draft: SpecReviewDraft) => void;
  onRemoveDraft: (id: string) => void;
  onResolve: (commentId: number) => void;
  resolving?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_FOLDS);
  /** A drag is in flight: its selection is not final until the pointer lifts. */
  const draggingRef = useRef(false);
  /** The entry is being pressed: the selection may vanish, the anchor stays. */
  const pressingUiRef = useRef(false);
  const pressTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<PendingSelection | null>(null);
  const pointerFine = useMediaQuery(POINTER_FINE);

  const index = useMemo(() => buildSegmentIndex(body), [body]);
  const baselineIndex = useMemo(
    () => (baselineBody === undefined ? null : buildSegmentIndex(baselineBody)),
    [baselineBody],
  );
  const decorations = useMemo(
    () =>
      mergeDecorations(
        baselineIndex === null
          ? NO_DECORATIONS
          : changeDecorations(baselineIndex, index),
        annotationDecorations(
          index,
          annotations.map((a) => ({
            key: a.key,
            kind: a.kind,
            start: a.start,
            end: a.end,
            colStart: a.colStart ?? null,
            colEnd: a.colEnd ?? null,
          })),
        ),
      ),
    [index, baselineIndex, annotations],
  );
  const fenceBaselines = useMemo(
    () =>
      baselineIndex === null ? undefined : pairedFences(baselineIndex, index),
    [baselineIndex, index],
  );
  const annotationRanges = useMemo(
    () => annotations.map((a) => ({ start: a.start, end: a.end })),
    [annotations],
  );
  // Referential stability is load-bearing, not tidiness: a fresh plugin
  // array re-runs react-markdown and rebuilds the text nodes a live
  // selection lives in (T-60). None of these inputs move while a selection
  // is pending — folding is switched from the toolbar, and opening a
  // placeholder is a click, which no selection outlives anyway.
  const rehypePlugins = useMemo<RehypePlugins>(() => {
    const decorated =
      decorations.spans.length > 0 ||
      decorations.deletions.length > 0 ||
      decorations.blocks.length > 0 ||
      decorations.tables.length > 0 ||
      decorations.images.length > 0;
    // Annotations alone used to take this exit: they always come with
    // decorations to paint. A `<details>` that has to be opened for them does
    // not, and skipping the array would leave the chip pointing into a fold
    // nothing ever opened.
    if (!decorated && !foldUnchanged && annotationRanges.length === 0) {
      return REHYPE_PLUGINS;
    }
    // This order is the only thing holding the three passes together, and
    // nothing but the array enforces it: rehypeExpandDetails reads the classes
    // rehypeDecorations paints, and rehypeFoldUnchanged counts top-level
    // blocks a fold has already been resolved into.
    const plugins: NonNullable<RehypePlugins> = [rehypeSourceLines];
    if (decorated) plugins.push([rehypeDecorations, decorations]);
    plugins.push([rehypeExpandDetails, { changedRanges, annotationRanges }]);
    if (foldUnchanged) {
      plugins.push([
        rehypeFoldUnchanged,
        { changedRanges, annotationRanges, expanded, keepHeading: true },
      ]);
    }
    return plugins;
  }, [decorations, foldUnchanged, changedRanges, annotationRanges, expanded]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different document, or folding switched, invalidates both which folds are open and where a pending selection sat
  useEffect(() => {
    setExpanded(NO_FOLDS);
    setPending(null);
  }, [body, baselineBody, foldUnchanged]);

  /**
   * Read the live selection and place the entry.
   *
   * `keepOnEmpty` is the window-resize path: a resize is not a reason to
   * drop an entry, and the selection may well have survived it untouched.
   */
  const decide = useCallback(
    (keepOnEmpty = false) => {
      const container = containerRef.current;
      if (!container) return;
      const selection = window.getSelection();
      // The cheap branch. `selectionchange` arrives every frame of a drag,
      // while a full recompute walks every open shadow root under the
      // container, so emptiness is settled before anything is measured —
      // by `toString()` rather than `isCollapsed`, which lies about shadow
      // selections (T-164) and would take a live selection's entry with it.
      if (selection === null || selection.toString() === "") {
        // A press on the entry itself collapses the selection before the
        // click lands. The anchor is already stored in `pending`, and the
        // click reads it from there, so the press window keeps it (T-60).
        if (!keepOnEmpty && !pressingUiRef.current) setPending(null);
        return;
      }
      // Mid-drag the entry would sit under the words still being selected,
      // and every frame would pay for a recompute. `pointerup` schedules
      // the one that counts.
      if (draggingRef.current) return;
      const ends = selectionEndpoints(selection, container);
      if (ends === null || ends.collapsed) {
        setPending(null);
        return;
      }
      const anchor = anchorForSelection(container, index, ends);
      if (anchor === null) {
        setPending(null);
        return;
      }
      setPending({ top: entryTop(container, selection, ends), ...anchor });
    },
    [index],
  );

  const layout = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const els = [
      ...container.querySelectorAll<HTMLElement>(`[${SOURCE_LINE_ATTR}]`),
    ];
    const blocks = els.map((el) => ({
      el,
      ...(parseSourceLoc(el.getAttribute(SOURCE_LINE_ATTR)) ?? {
        start: 0,
        end: 0,
      }),
    }));
    const grouped = new Map<number, DisplayedAnnotation[]>();
    for (const annotation of annotations) {
      const index = blockForLine(blocks, annotation.start);
      if (index < 0) continue;
      grouped.set(index, [...(grouped.get(index) ?? []), annotation]);
    }
    // Innermost wins: one edited cell lights its own row, not the table it
    // sits in (T-142). Ancestors that only contain a marked descendant stay
    // plain, so the ↑↓ navigation lands on rows rather than whole tables.
    const changed = blocks.filter((block) =>
      changedRanges.some((range) =>
        rangesIntersect(range, { start: block.start, end: block.end }),
      ),
    );
    for (const block of blocks) {
      block.el.classList.remove("spec-annotated");
      block.el.classList.toggle(
        "spec-changed",
        changed.includes(block) &&
          !changed.some(
            (other) => other !== block && block.el.contains(other.el),
          ) &&
          // A wholly-new block already says so, louder (T-158). Stacking
          // the "something here changed" wash under it only shifts the
          // padding and muddies the colour.
          block.el.closest(`.${INS_BLOCK_CLASS}`) === null,
      );
    }
    const next: Chip[] = [];
    for (const [index, items] of grouped) {
      const block = blocks[index];
      if (block === undefined) continue;
      // A column-anchored comment paints its own words; the block-wide
      // amber would only smear over the precision it just gained.
      if (items.some((item) => (item.colStart ?? null) === null)) {
        block.el.classList.add("spec-annotated");
      }
      next.push({
        blockKey: `${block.start}-${block.end}`,
        // The key still names the block the annotation belongs to; only what
        // gets measured moves when the reader shuts a fold over it.
        top: chipTop(containerRect, visibleAnchor(block.el)),
        items,
      });
    }
    next.sort((a, b) => a.top - b.top);
    setChips((prev) => {
      const same =
        prev.length === next.length &&
        prev.every(
          (chip, i) =>
            chip.blockKey === next[i]?.blockKey &&
            chip.top === next[i]?.top &&
            chip.items.length === next[i]?.items.length &&
            chip.items.every((item, j) => item.key === next[i]?.items[j]?.key),
        );
      return same ? prev : next;
    });
  }, [annotations, changedRanges]);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useLayoutEffect(() => {
    layout();
    // A resize moves the chips and the entry alike, and the entry's `top`
    // was measured against a selection rect that has since moved. Recompute
    // it from the live selection, or leave it where it is when there is no
    // selection left to measure.
    const onResize = () => {
      layout();
      if (pendingRef.current !== null) decide(true);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [layout, decide]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: folding moves the blocks the chips are measured against
  useLayoutEffect(() => {
    layout();
  }, [layout, expanded, foldUnchanged]);

  // `toggle` does not bubble, so the capture phase is the only way one
  // listener hears every `<details>` under the container, nested ones
  // included.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    container.addEventListener("toggle", layout, true);
    return () => container.removeEventListener("toggle", layout, true);
  }, [layout]);

  /** Jump to what a popover entry points at — its own mark, or its block. */
  const flashAnnotation = useCallback(
    (annotation: DisplayedAnnotation, blockKey: string) => {
      const container = containerRef.current;
      if (!container) return;
      const target =
        container.querySelector<HTMLElement>(
          `[${MARK_KEY_ATTR}="${annotation.key}"]`,
        ) ??
        container.querySelector<HTMLElement>(
          `[${SOURCE_LINE_ATTR}="${blockKey}"]`,
        );
      if (target === null) return;
      revealBlock(target, { behavior: "smooth" });
    },
    [],
  );

  /**
   * Every path that changes a selection, which is the point of T-384: the
   * old container `mouseup` heard mouse drags that ended inside the prose
   * and nothing else — not the keyboard, not a drag released outside, and
   * on a touchscreen not the long-press gesture, for which no compatibility
   * mouse event is ever synthesised.
   */
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let frame: number | null = null;
    const schedule = () => {
      if (typeof requestAnimationFrame !== "function") {
        decide();
        return;
      }
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        decide();
      });
    };
    const clearPressWindow = () => {
      pressingUiRef.current = false;
      if (pressTimerRef.current !== null) {
        window.clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    };
    // Closing the press window re-reads the selection, because what the
    // window held back is exactly the "the selection is gone" verdict: a
    // press that ended on something other than the entry — a chip, or the
    // prose beside it — has to leave the entry pointing at nothing.
    const releaseUi = () => {
      clearPressWindow();
      schedule();
    };
    document.addEventListener("selectionchange", schedule, { signal });
    document.addEventListener(
      "pointerdown",
      (event) => {
        const onUi =
          event.target instanceof Element &&
          event.target.closest("[data-annotation-ui]") !== null;
        if (!onUi) {
          draggingRef.current = true;
          return;
        }
        pressingUiRef.current = true;
        // The window has to close by itself too: a press that slides off
        // the entry fires neither `click` nor `pointercancel`, and leaving
        // it open would keep a dead anchor on screen indefinitely.
        pressTimerRef.current = window.setTimeout(releaseUi, PRESS_WINDOW_MS);
      },
      { capture: true, signal },
    );
    document.addEventListener(
      "pointerup",
      () => {
        draggingRef.current = false;
        schedule();
      },
      { signal },
    );
    document.addEventListener(
      "pointercancel",
      () => {
        draggingRef.current = false;
        releaseUi();
      },
      { signal },
    );
    document.addEventListener("click", releaseUi, { signal });
    return () => {
      controller.abort();
      if (frame !== null) cancelAnimationFrame(frame);
      clearPressWindow();
    };
  }, [decide]);

  /** The fold placeholders are markdown-side nodes, so React never sees them. */
  const onClick = useCallback((event: ReactMouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const key = event.target
      .closest(`.${FOLD_CLASS}`)
      ?.getAttribute(FOLD_KEY_ATTR);
    if (key === null || key === undefined) return;
    setExpanded((prev) => new Set([...prev, key]));
    setPending(null);
  }, []);

  const stagePending = useCallback(() => {
    if (pending === null) return;
    onStage({
      lineStart: pending.lineStart,
      lineEnd: pending.lineEnd,
      colStart: pending.colStart,
      colEnd: pending.colEnd,
    });
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }, [pending, onStage]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click only delegates to the fold placeholders; blocks stay natively selectable
    // biome-ignore lint/a11y/useKeyWithClickEvents: what the click delegates to is a real <button>, which answers Enter and Space by firing this same click
    <div
      ref={containerRef}
      className="relative pr-10"
      onClick={onClick}
      data-testid="annotated-markdown"
    >
      <MarkdownView
        slug={slug}
        issueNumber={issueNumber}
        rehypePlugins={rehypePlugins}
        fenceBaselines={fenceBaselines}
      >
        {body}
      </MarkdownView>

      {chips.map((chip) => (
        <AnnotationChip
          key={chip.blockKey}
          chip={chip}
          onFlash={flashAnnotation}
          onEditDraft={onEditDraft}
          onRemoveDraft={onRemoveDraft}
          onResolve={onResolve}
          resolving={resolving}
        />
      ))}

      {pending !== null &&
        (pointerFine ? (
          <StageButton
            size="sm"
            className="absolute right-0 z-10 shadow-md"
            style={{ top: pending.top }}
            anchor={pending}
            onStage={stagePending}
          />
        ) : (
          // Touch selection comes with the platform's own bubble, floating
          // against the selection, which we can neither move nor dismiss.
          // Pinned to the bottom of the viewport is the one place the two
          // cannot claim at once — and the one place a thumb always reaches.
          // No `env(safe-area-inset-bottom)`: without `viewport-fit=cover`
          // iOS has already inset the page, and a second one would show.
          <div
            className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-2 backdrop-blur"
            data-annotation-ui=""
            data-testid="annotation-action-bar"
          >
            <StageButton
              size="lg"
              className="w-full"
              anchor={pending}
              onStage={stagePending}
            />
          </div>
        ))}
    </div>
  );
}

/** The entry itself, in both of the shapes it takes. */
function StageButton({
  anchor,
  size,
  className,
  style,
  onStage,
}: {
  anchor: AnchorRange;
  size: "sm" | "lg";
  className: string;
  style?: CSSProperties;
  onStage: () => void;
}) {
  return (
    <Button
      size={size}
      className={className}
      style={style}
      data-annotation-ui=""
      // A mouse press would collapse the selection under the button (and
      // move focus) before click fires, and the selection has to outlive
      // the press (T-60). A touch press is left alone: cancelling it has no
      // agreed effect on whether `click` follows, and the press window
      // holds the anchor either way.
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") e.preventDefault();
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onStage}
    >
      <MessageSquarePlusIcon className="size-4" />
      Comment{" "}
      {formatAnchorRange({
        line_start: anchor.lineStart,
        line_end: anchor.lineEnd,
        col_start: anchor.colStart,
        col_end: anchor.colEnd,
      })}
    </Button>
  );
}

function AnnotationChip({
  chip,
  onFlash,
  onEditDraft,
  onRemoveDraft,
  onResolve,
  resolving,
}: {
  chip: Chip;
  onFlash: (annotation: DisplayedAnnotation, blockKey: string) => void;
  onEditDraft: (draft: SpecReviewDraft) => void;
  onRemoveDraft: (id: string) => void;
  onResolve: (commentId: number) => void;
  resolving: boolean;
}) {
  const draftCount = chip.items.filter((i) => i.kind === "draft").length;
  const locate = (item: DisplayedAnnotation) => (
    <button
      type="button"
      className="cursor-pointer hover:underline"
      title="Scroll to what this points at"
      onClick={() => onFlash(item, chip.blockKey)}
    >
      {labelOf(item)}
    </button>
  );
  return (
    <Popover>
      <PopoverTrigger
        data-annotation-ui=""
        className={`absolute right-0 inline-flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow-sm ${
          draftCount > 0
            ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400"
            : "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        }`}
        style={{ top: chip.top }}
        aria-label={`${chip.items.length} comment(s) on this block`}
      >
        <MessageSquareTextIcon className="size-3.5" />
        {chip.items.length}
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        className="max-h-96 w-96 space-y-3 overflow-y-auto"
      >
        {chip.items.map((item) =>
          item.kind === "draft" ? (
            <div
              key={item.key}
              className="rounded-md border border-indigo-500/40 p-2 text-sm"
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-indigo-700 dark:text-indigo-400">
                  draft
                </span>
                {locate(item)}
                <span className="ml-auto" />
                {/* Editing reopens the composer, which the popover would
                    cover — close it on the way out. */}
                <PopoverClose asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => onEditDraft(item.draft)}
                  >
                    Edit
                  </Button>
                </PopoverClose>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => onRemoveDraft(item.draft.id)}
                >
                  Discard
                </Button>
              </div>
              <p className="whitespace-pre-wrap">{item.draft.body}</p>
            </div>
          ) : (
            <div key={item.key} className="rounded-md border p-2 text-sm">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <UserChip user={item.item.author} />
                <span title={item.item.created_at}>
                  {locate(item)} · v{item.item.anchor.version}
                </span>
                <span className="ml-auto" />
                {item.item.resolved === null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    disabled={resolving}
                    onClick={() => onResolve(item.item.comment_id)}
                  >
                    <CheckIcon className="size-3" />
                    Resolve
                  </Button>
                ) : (
                  <span
                    className="text-green-700 dark:text-green-400"
                    title={`resolved by ${displayNameOf(item.item.resolved.by)}`}
                  >
                    resolved
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap">{item.item.body}</p>
            </div>
          ),
        )}
      </PopoverContent>
    </Popover>
  );
}
