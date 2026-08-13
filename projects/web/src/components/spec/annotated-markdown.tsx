import type { SpecCommentItem } from "@todou/shared";
import {
  CheckIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CODE_CONTENT_START_ATTR,
  parseSourceLoc,
  rehypeSourceLines,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import { type LineRange, rangesIntersect } from "@/lib/spec-changes.ts";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";

// Stable array — MarkdownView passes it straight to react-markdown.
const REHYPE_PLUGINS = [rehypeSourceLines];

export type DisplayedAnnotation = {
  key: string;
  /** 1-based inclusive lines in the *viewed* version. */
  start: number;
  end: number;
} & (
  | { kind: "comment"; item: SpecCommentItem }
  | { kind: "draft"; draft: SpecReviewDraft }
);

type Chip = {
  blockKey: string;
  top: number;
  items: DisplayedAnnotation[];
};

type PendingSelection = {
  top: number;
  lineStart: number;
  lineEnd: number;
};

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

/** First block (document order) whose source range contains `line`. */
export function blockForLine(
  blocks: Array<{ start: number; end: number }>,
  line: number,
): number {
  let fallback = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (line >= block.start && line <= block.end) return i;
    if (block.start <= line) fallback = i;
  }
  return fallback;
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
  refDate,
  annotations,
  changedRanges = [],
  onStage,
  onRemoveDraft,
  onResolve,
  resolving = false,
}: {
  slug: string;
  issueNumber: number;
  body: string;
  /** The viewed spec version's push time (T-80 time cutoff). */
  refDate?: string;
  annotations: DisplayedAnnotation[];
  /** Lines changed since the compare baseline — green highlight + ↑↓ nav. */
  changedRanges?: LineRange[];
  /** Stage a draft for the given source line range of the viewed version. */
  onStage: (range: { lineStart: number; lineEnd: number }) => void;
  onRemoveDraft: (id: string) => void;
  onResolve: (commentId: number) => void;
  resolving?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [pending, setPending] = useState<PendingSelection | null>(null);

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
    for (const block of blocks) {
      block.el.classList.remove("spec-annotated");
      block.el.classList.toggle(
        "spec-changed",
        changedRanges.some((range) =>
          rangesIntersect(range, { start: block.start, end: block.end }),
        ),
      );
    }
    const next: Chip[] = [];
    for (const [index, items] of grouped) {
      const block = blocks[index];
      if (block === undefined) continue;
      block.el.classList.add("spec-annotated");
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

  const onMouseUp = useCallback((event: ReactMouseEvent) => {
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
      lineStart: Math.min(from.start, to.start),
      lineEnd: Math.max(from.end, to.end),
    });
  }, []);

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
        rehypePlugins={REHYPE_PLUGINS}
      >
        {body}
      </MarkdownView>

      {chips.map((chip) => (
        <AnnotationChip
          key={chip.blockKey}
          chip={chip}
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
            onStage({ lineStart: pending.lineStart, lineEnd: pending.lineEnd });
            setPending(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <MessageSquarePlusIcon className="size-4" />
          Comment L{pending.lineStart}
          {pending.lineEnd !== pending.lineStart && `–${pending.lineEnd}`}
        </Button>
      )}
    </div>
  );
}

function AnnotationChip({
  chip,
  onRemoveDraft,
  onResolve,
  resolving,
}: {
  chip: Chip;
  onRemoveDraft: (id: string) => void;
  onResolve: (commentId: number) => void;
  resolving: boolean;
}) {
  const draftCount = chip.items.filter((i) => i.kind === "draft").length;
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
                L{item.start}
                {item.end !== item.start && `–${item.end}`}
                <span className="ml-auto" />
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
                  L{item.start}
                  {item.end !== item.start && `–${item.end}`} · v
                  {item.item.anchor.version}
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
                    title={`resolved by ${item.item.resolved.by.login}`}
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
