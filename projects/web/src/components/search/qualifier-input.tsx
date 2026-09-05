import type { ReactNode, RefObject } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Where the caret is: an offset in the string. */
export type CaretPosition = { caret: number };

/**
 * Everything that decides where a glyph lands, worn by both layers. They have
 * to measure identically — the mirror is painted under a transparent input,
 * and one pixel of drift puts the caret beside the character it is standing
 * on rather than on it. Nothing here may differ between the two, and no span
 * inside the mirror may add width of its own.
 */
const METRICS = "px-2.5 py-1 text-base md:text-sm";

/**
 * A one-line input that shows its own text through a mirror layer, so the
 * text can be coloured while the input keeps being an input (T-262).
 *
 * The border and background belong to the wrapper; the mirror draws the
 * coloured text inside it; the input lies on top with no background and no
 * text colour, contributing only its caret and its selection. That order is
 * what keeps native selection, undo, IME composition, autofill and every
 * keyboard behaviour intact — a `contenteditable` or an array of chips would
 * have to reimplement all of them, and Chinese composition is exactly where
 * such reimplementations fail.
 *
 * This component does not know what a qualifier is. It takes the string and a
 * function that draws it, and reports where the caret is; what the colours
 * mean belongs to the caller.
 *
 * While an IME is composing, the two layers trade places: the input's own
 * text becomes visible and the mirror keeps only its backgrounds. Pre-commit
 * text — the underlined candidate an IME shows before it is chosen — is drawn
 * by the browser inside the input, and a transparent input would swallow it.
 * Most queries here are Chinese, so this is the common path, not an edge.
 */
export function QualifierInput({
  value,
  onValueChange,
  render,
  onCaretChange,
  inputRef,
  padding,
  className,
  ...rest
}: Omit<React.ComponentProps<"input">, "value" | "onChange" | "children"> & {
  value: string;
  onValueChange: (next: string) => void;
  /** The same characters as `value`, in spans. Never a different string. */
  render: (value: string) => ReactNode;
  /** Where the caret is, after anything that could have moved it. */
  onCaretChange?: (position: CaretPosition) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Extra padding, applied to both layers so they keep measuring alike. */
  padding?: string;
}) {
  const own = useRef<HTMLInputElement>(null);
  const input = inputRef ?? own;
  const [scroll, setScroll] = useState(0);
  const [composing, setComposing] = useState(false);
  const reported = useRef<CaretPosition>({ caret: 0 });

  const report = () => {
    const el = input.current;
    if (el === null) return;
    setScroll(el.scrollLeft);
    const caret = el.selectionStart ?? el.value.length;
    // Only on a real change: this also runs after every render, and handing
    // the caller a fresh object each time would spin it.
    if (reported.current.caret === caret) return;
    reported.current = { caret };
    onCaretChange?.(reported.current);
  };

  // No dependency list, deliberately: the browser moves `scrollLeft` as the
  // value and the caret change, and the render that follows was queued
  // before it did. `report` bails when nothing actually moved.
  useLayoutEffect(report);

  return (
    <div
      className={cn(
        "relative h-8 rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          // `items-center` because that is what an input does with its single
          // line, and a block layout would sit it at the top instead.
          "pointer-events-none absolute inset-0 flex items-center",
          // Reaching into the spans, because each one sets its own colour and
          // a colour on the parent would lose to it.
          composing && "[&_span]:text-transparent",
          METRICS,
          padding,
        )}
      >
        {/*
         * The clip lives one layer in, so that its border box is the outer
         * layer's *content* box — which is where a real `input` clips. Left
         * on the outer layer it would clip at the padding box instead, and a
         * scrolled query would keep painting across the padding and over the
         * search icon sitting in it (T-268).
         *
         * Nothing but these three classes may go here: padding, border or
         * anything about the font would move the mirror relative to the input
         * and stand the caret beside its character.
         */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <span
            className="block w-max whitespace-pre"
            style={{ transform: `translateX(${-scroll}px)` }}
          >
            {render(value)}
          </span>
        </div>
      </div>
      <input
        {...rest}
        ref={input}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          report();
        }}
        onScroll={report}
        onSelect={report}
        onKeyUp={report}
        onClick={report}
        onFocus={(e) => {
          report();
          rest.onFocus?.(e);
        }}
        onCompositionStart={(e) => {
          setComposing(true);
          rest.onCompositionStart?.(e);
        }}
        onCompositionEnd={(e) => {
          setComposing(false);
          rest.onCompositionEnd?.(e);
        }}
        className={cn(
          "relative h-full w-full min-w-0 bg-transparent caret-foreground outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          composing ? "text-foreground" : "text-transparent",
          // Translucent, or the selection paints over the mirror and the
          // reader loses sight of the very text they are selecting.
          "selection:bg-primary/30",
          composing
            ? "selection:text-foreground"
            : "selection:text-transparent",
          METRICS,
          padding,
        )}
      />
    </div>
  );
}
