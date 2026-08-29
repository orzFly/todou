import { formatAnchorRange, type SpecCommentItem } from "@todou/shared";
import {
  CheckIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
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
import {
  CODE_CONTENT_START_ATTR,
  parseSourceLoc,
  rehypeSourceLines,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import { type LineRange, rangesIntersect } from "@/lib/spec-changes.ts";
import {
  annotationDecorations,
  changeDecorations,
  mergeDecorations,
} from "@/lib/spec-decorations.ts";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";
import {
  buildSegmentIndex,
  lineColAt,
  type SegmentIndex,
  segmentsInLines,
  sourceOffsetOfRendered,
} from "@/lib/spec-source-index.ts";

type RehypePlugins = ComponentProps<typeof Markdown>["rehypePlugins"];

// Stable array — MarkdownView passes it straight to react-markdown.
const REHYPE_PLUGINS: RehypePlugins = [rehypeSourceLines];

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
 * The block a selection endpoint sits in, when that block can carry column
 * precision. Code blocks are excluded on purpose: their text reaches the
 * DOM through pierre's own renderer (T-31/T-52), so DOM offsets there say
 * nothing about the markdown source and the anchor stays line-level.
 */
function columnBlockOf(
  node: Node,
): { el: Element; loc: { start: number; end: number } } | null {
  const from = node instanceof Element ? node : node.parentElement;
  const stamped = from?.closest(`[${SOURCE_LINE_ATTR}]`) ?? null;
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
  // Columns are inclusive and must name a real character: a selection that
  // ran to the end of a line would otherwise land on the newline, which is
  // past the line the server measures.
  let last = end - 1;
  while (last > start && index.source[last] === "\n") last--;
  const from = lineColAt(index, start);
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
  let el: Element | null =
    node instanceof Element ? node : (node.parentElement ?? null);
  let row: Element | null = null;
  while (el !== null) {
    row ??= el.closest("[data-line]");
    const stamped = el.closest(`[${SOURCE_LINE_ATTR}]`);
    if (stamped !== null) {
      const loc = parseSourceLoc(stamped.getAttribute(SOURCE_LINE_ATTR));
      if (loc === null) return null;
      if (row !== null) {
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
  refDate,
  annotations,
  changedRanges = [],
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
  refDate?: string;
  annotations: DisplayedAnnotation[];
  /** Lines changed since the compare baseline — green highlight + ↑↓ nav. */
  changedRanges?: LineRange[];
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
  // Referential stability is load-bearing, not tidiness: a fresh plugin
  // array re-runs react-markdown and rebuilds the text nodes a live
  // selection lives in (T-60). None of these inputs move while a selection
  // is pending.
  const rehypePlugins = useMemo<RehypePlugins>(
    () =>
      decorations.spans.length === 0 &&
      decorations.deletions.length === 0 &&
      decorations.blocks.length === 0
        ? REHYPE_PLUGINS
        : [rehypeSourceLines, [rehypeDecorations, decorations]],
    [decorations],
  );

  const layout = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
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
        top: block.el.offsetTop,
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

  useLayoutEffect(() => {
    layout();
    window.addEventListener("resize", layout);
    return () => window.removeEventListener("resize", layout);
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
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      // Same flash as timeline anchors (T-38): remove → reflow → re-add.
      target.classList.remove("anchor-flash");
      void target.offsetWidth;
      target.classList.add("anchor-flash");
    },
    [],
  );

  const onMouseUp = useCallback(
    (event: ReactMouseEvent) => {
      // Presses on the annotation UI itself (floating button, chips) bubble
      // through here too; deriving state from them would clear `pending`
      // and unmount the button before its click can fire (T-60).
      if (
        event.target instanceof Element &&
        event.target.closest("[data-annotation-ui]") !== null
      ) {
        return;
      }
      const container = containerRef.current;
      if (!container) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPending(null);
        return;
      }
      const range = selection.getRangeAt(0);
      // Chrome re-targets getRangeAt endpoints to the shadow host while
      // anchor/focus keep pointing inside the open shadow root — prefer
      // those (direction doesn't matter, min/max below absorbs it).
      const startNode = selection.anchorNode ?? range.startContainer;
      const endNode = selection.focusNode ?? range.endContainer;
      if (!composedContains(container, startNode)) return;
      const from = anchorRangeForNode(startNode);
      const to = anchorRangeForNode(endNode);
      if (!from || !to) {
        setPending(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setPending({
        top: rect.bottom - containerRect.top + 6,
        // Columns narrow the anchor to what was actually selected; without
        // them the whole block's line range stands, as it always has.
        ...(columnsOfSelection(index, range) ?? {
          lineStart: Math.min(from.start, to.start),
          lineEnd: Math.max(from.end, to.end),
          colStart: null,
          colEnd: null,
        }),
      });
    },
    [index],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouseup only reads the text selection; blocks stay natively selectable
    <div
      ref={containerRef}
      className="relative pr-10"
      onMouseUp={onMouseUp}
      data-testid="annotated-markdown"
    >
      <MarkdownView
        slug={slug}
        issueNumber={issueNumber}
        refDate={refDate}
        rehypePlugins={rehypePlugins}
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

      {pending && (
        <Button
          size="sm"
          className="absolute right-0 z-10 shadow-md"
          style={{ top: pending.top }}
          data-annotation-ui=""
          // The browser's default pointer/mouse-down would collapse the
          // text selection under the button (and move focus) before click
          // fires — the selection must outlive the press (T-60).
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onStage({
              lineStart: pending.lineStart,
              lineEnd: pending.lineEnd,
              colStart: pending.colStart,
              colEnd: pending.colEnd,
            });
            setPending(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <MessageSquarePlusIcon className="size-4" />
          Comment{" "}
          {formatAnchorRange({
            line_start: pending.lineStart,
            line_end: pending.lineEnd,
            col_start: pending.colStart,
            col_end: pending.colEnd,
          })}
        </Button>
      )}
    </div>
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
