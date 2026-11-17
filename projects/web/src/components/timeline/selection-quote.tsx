import { TextQuoteIcon } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type QuoteTarget,
  useQuoteReply,
} from "@/components/timeline/quote-reply.tsx";
import { Button } from "@/components/ui/button";
import { sourceLines } from "@/lib/quote-markdown.ts";
import { selectedSourceRange } from "@/lib/quote-selection.ts";
import { POINTER_FINE, useMediaQuery } from "@/lib/use-media-query.ts";

/** Marks the floating entry, so a press on it is not a new selection. */
const UI_ATTR = "data-selection-quote";

/** How long a press on the entry may hold a selection the press collapsed. */
const PRESS_WINDOW_MS = 300;

/** Where the entry sits, in document coordinates, and what it quotes. */
type Pending = { markdown: string; top: number; right: number };

/** The registered body both ends of `range` sit in, or null. */
function targetOf(
  targets: Map<Element, QuoteTarget>,
  range: Range,
): { el: Element; target: QuoteTarget } | null {
  const start = range.startContainer;
  for (
    let el: Element | null =
      start instanceof Element ? start : start.parentElement;
    el !== null;
    el = el.parentElement
  ) {
    const target = targets.get(el);
    if (target === undefined) continue;
    // A selection that runs on into the next entry, or up into this one's
    // header, is not a quote from one body.
    return el.contains(range.endContainer) ? { el, target } : null;
  }
  return null;
}

/**
 * The floating Quote reply (T-723): select text inside one entry's body and
 * the entry's own Quote reply comes to the selection, without the `…`. It
 * follows the spec review page's Comment entry — under the selection's last
 * line on the body's right edge for a mouse, a bar pinned to the viewport's
 * foot for touch — and the press handling that lets it outlive the selection
 * its own press collapses (T-60) is the same.
 */
export function SelectionQuote() {
  const { available, quote, targets } = useQuoteReply();
  const pointerFine = useMediaQuery(POINTER_FINE);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const dragging = useRef(false);
  const pressingUi = useRef(false);

  const decide = useCallback(
    (keepOnEmpty = false) => {
      const selection = window.getSelection();
      if (
        selection === null ||
        selection.rangeCount === 0 ||
        selection.toString() === ""
      ) {
        if (!keepOnEmpty && !pressingUi.current) setPending(null);
        return;
      }
      // Mid-drag the entry would sit under the words still being selected;
      // `pointerup` schedules the read that counts.
      if (dragging.current) return;
      const range = selection.getRangeAt(0);
      const found = targetOf(targets, range);
      const lines = found === null ? null : selectedSourceRange(found.el);
      const markdown =
        found === null || lines === null
          ? ""
          : sourceLines(found.target.body(), lines.start, lines.end);
      if (found === null || markdown === "") {
        setPending(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const frame = found.target.frame().getBoundingClientRect();
      setPending({
        markdown,
        // Never below the body: a selection ending on a block's last
        // character can report the rect of the empty line after it.
        top: Math.min(rect.bottom, frame.bottom) + window.scrollY + 6,
        right: frame.right + window.scrollX,
      });
    },
    [targets],
  );

  // Every path that changes a selection, as on the spec page (T-384):
  // keyboard, a drag released anywhere, and the touch long-press.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let frame: number | null = null;
    let pressTimer: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        decide();
      });
    };
    const clearPressWindow = () => {
      pressingUi.current = false;
      if (pressTimer !== null) {
        window.clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    // What the window held back is the "selection is gone" verdict, so
    // closing it has to read the selection again.
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
          event.target.closest(`[${UI_ATTR}]`) !== null;
        if (!onUi) {
          dragging.current = true;
          return;
        }
        pressingUi.current = true;
        // A press that slides off the entry fires neither `click` nor
        // `pointercancel`, and must not keep a dead entry on screen.
        pressTimer = window.setTimeout(releaseUi, PRESS_WINDOW_MS);
      },
      { capture: true, signal },
    );
    document.addEventListener(
      "pointerup",
      () => {
        dragging.current = false;
        schedule();
      },
      { signal },
    );
    document.addEventListener(
      "pointercancel",
      () => {
        dragging.current = false;
        releaseUi();
      },
      { signal },
    );
    document.addEventListener("click", releaseUi, { signal });
    // The entry was measured against a layout a resize has moved; with no
    // selection left to measure, it stays where it is.
    window.addEventListener(
      "resize",
      () => {
        if (pendingRef.current !== null) decide(true);
      },
      { signal },
    );
    return () => {
      controller.abort();
      if (frame !== null) cancelAnimationFrame(frame);
      clearPressWindow();
    };
  }, [decide]);

  if (!available || pending === null) return null;

  const onQuote = () => {
    quote(pending.markdown);
    setPending(null);
    window.getSelection()?.removeAllRanges();
  };

  return createPortal(
    pointerFine ? (
      <QuoteButton
        size="sm"
        className="absolute z-10 -translate-x-full shadow-md"
        style={{ top: pending.top, left: pending.right }}
        onQuote={onQuote}
      />
    ) : (
      // The platform's own bubble floats against a touch selection, and
      // neither can move the other; the viewport's foot is the one place
      // both fit, and the one a thumb always reaches.
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-2 backdrop-blur"
        {...{ [UI_ATTR]: "" }}
      >
        <QuoteButton size="lg" className="w-full" onQuote={onQuote} />
      </div>
    ),
    document.body,
  );
}

function QuoteButton({
  size,
  className,
  style,
  onQuote,
}: {
  size: "sm" | "lg";
  className: string;
  style?: CSSProperties;
  onQuote: () => void;
}) {
  return (
    <Button
      size={size}
      className={className}
      style={style}
      {...{ [UI_ATTR]: "" }}
      // A mouse press would collapse the selection under the button before
      // `click` fires (T-60); a touch press is left to the press window.
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") e.preventDefault();
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onQuote}
    >
      <TextQuoteIcon className="size-3.5" />
      Quote reply
    </Button>
  );
}
