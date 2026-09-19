import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  allocateCommentRef,
  splitCommentIssueRef,
} from "@/lib/comment-ref-layout.ts";
import "./comment-reference.css";

export type CommentReferenceProps = {
  spelled: string;
  slug: string;
  prefix: string | null;
  number: number;
  commentId: number;
  title: string | null;
  refLeads: boolean;
  inBody: boolean;
  capTitle: boolean;
  author: string;
  current: boolean;
};

type SegmentLayout = {
  width: number;
  tailWidth: number;
  tailCount: number;
  clipped: boolean;
};
type Layout = {
  segments: SegmentLayout[];
  wrap: boolean;
  available: number;
};

const pixels = (value: string) => Number.parseFloat(value) || 0;

function contentContainer(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent) {
    const { display } = getComputedStyle(parent);
    if (
      display !== "" &&
      display !== "none" &&
      display !== "contents" &&
      display !== "inline" &&
      !display.startsWith("inline-")
    ) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

/** Measure the actual rendered text nodes, including their clipped characters. */
function textWidth(element: Element, start = 0, end = Infinity): number {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    const from = Math.max(0, start - offset);
    const to = Math.min(length, end - offset);
    if (from < to) {
      range.setStart(node, from);
      range.setEnd(node, to);
      for (const rect of range.getClientRects()) width += rect.width;
    }
    offset += length;
  }
  return width;
}

function segmentMeasurer(element: Element, text: string) {
  const style = getComputedStyle(element);
  // A clipped DOM Range can report both the full text and an extra visual
  // ellipsis fragment. Measuring the original substrings on canvas avoids
  // counting that decoration and keeps 1/3 tail changes independent of layout.
  // Canvas creates neither a DOM text copy nor a second selectable identity.
  const context = document.createElement("canvas").getContext("2d");
  if (context) {
    context.font = style.font;
    context.fontKerning = style.fontKerning as CanvasFontKerning;
    context.fontStretch = style.fontStretch as CanvasFontStretch;
    context.fontVariantCaps = style.fontVariantCaps as CanvasFontVariantCaps;
    context.textRendering = style.textRendering as CanvasTextRendering;
    context.letterSpacing =
      style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
    context.wordSpacing =
      style.wordSpacing === "normal" ? "0px" : style.wordSpacing;
  }
  return {
    width(start = 0, end = text.length) {
      return context
        ? context.measureText(text.slice(start, end)).width
        : textWidth(element, start, end);
    },
    ellipsis: context?.measureText("…").width ?? pixels(style.fontSize),
  };
}

/** Contents of the existing navigable issue link; never creates another link. */
export function CommentReference({
  spelled,
  slug,
  prefix,
  number,
  commentId,
  title,
  refLeads,
  inBody,
  capTitle,
  author,
  current,
}: CommentReferenceProps) {
  const root = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const parts = useMemo(
    () => (current ? [] : splitCommentIssueRef(spelled, slug, prefix, number)),
    [spelled, slug, prefix, number, current],
  );
  const suffix = `#comment-${commentId}`;
  const shownTitle = current ? null : title;

  // The effect measures the committed text nodes, so identity changes must
  // remeasure even when the parent box and font have not changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: parts and suffix are the DOM measurement inputs.
  useLayoutEffect(() => {
    const element = root.current;
    if (!inBody || !element) return;
    const container = contentContainer(element);
    if (!container) return;
    const anchor = element.closest("a");
    let disposed = false;
    const measure = () => {
      // Keep observing the nearest container while a closed details/hidden
      // ancestor gives it no box; opening it must not use an outer width.
      if (disposed || container.clientWidth === 0) return;
      const containerStyle = getComputedStyle(container);
      let available =
        container.clientWidth -
        pixels(containerStyle.paddingLeft) -
        pixels(containerStyle.paddingRight);
      if (anchor) {
        const style = getComputedStyle(anchor);
        available -=
          pixels(style.paddingLeft) +
          pixels(style.paddingRight) +
          pixels(style.borderLeftWidth) +
          pixels(style.borderRightWidth);
        // The end edge a second time: `box-decoration-break: clone` repeats
        // it on every fragment, and Chromium reserves only the opening edge
        // when it breaks the line, so content runs to the paragraph's own
        // edge and the cloned closing box is drawn past it — 1.63px at 390px.
        available -=
          pixels(style.paddingRight) + pixels(style.borderRightWidth);
        const icon = anchor.querySelector(".comment-reference-icon");
        if (icon) {
          const iconStyle = getComputedStyle(icon);
          available -=
            icon.getBoundingClientRect().width +
            pixels(iconStyle.marginLeft) +
            pixels(iconStyle.marginRight);
        }
      }
      available = Math.max(0, available);
      const segments = Array.from(
        element.querySelectorAll<HTMLElement>("[data-comment-segment]"),
      );
      const metrics = segments.map((segment) => {
        const text = segment.textContent ?? "";
        const chars = Array.from(text);
        const first = chars[0]?.length ?? 0;
        const last = chars.at(-1)?.length ?? 0;
        const measured = segmentMeasurer(segment, text);
        const full = measured.width();
        const ellipsis = measured.ellipsis;
        const tailWidth = measured.width(text.length - last);
        const minimum =
          chars.length < 3
            ? full
            : Math.min(full, measured.width(0, first) + ellipsis + tailWidth);
        const headThree = chars.slice(0, 3).join("").length;
        const tailThree = chars.slice(-3).join("").length;
        return {
          full,
          minimum,
          tailWidth,
          threeWidth:
            chars.length > 6
              ? measured.width(0, headThree) +
                ellipsis +
                measured.width(text.length - tailThree)
              : Infinity,
          tailThreeWidth: measured.width(text.length - tailThree),
        };
      });
      const fixed = Array.from(
        element.querySelectorAll<HTMLElement>('[data-ref-part="fixed"]'),
      ).reduce((sum, part) => sum + textWidth(part), 0);
      // happy-dom has no text geometry. Leave its original DOM intact; only
      // real measurements (or deliberate test doubles) drive allocation.
      if (fixed === 0 && metrics.every(({ full }) => full === 0)) return;
      const allocation = allocateCommentRef(available, fixed, metrics);
      const next: Layout = {
        available,
        wrap: allocation.wrap,
        segments: metrics.map((metric, index) => {
          const width = allocation.widths[index];
          const three = !allocation.wrap && metric.threeWidth <= width;
          return {
            width,
            tailWidth: three ? metric.tailThreeWidth : metric.tailWidth,
            tailCount: three ? 3 : 1,
            clipped: width < metric.full - 0.01,
          };
        }),
      };
      setLayout((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(container);
    const chromeObserver =
      anchor && typeof MutationObserver !== "undefined"
        ? new MutationObserver(measure)
        : null;
    if (anchor) {
      chromeObserver?.observe(anchor, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }
    window.addEventListener("resize", measure);
    document.fonts?.addEventListener("loadingdone", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      disposed = true;
      observer?.disconnect();
      chromeObserver?.disconnect();
      window.removeEventListener("resize", measure);
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [inBody, parts, suffix]);

  const active = inBody ? layout : null;
  let segmentIndex = 0;
  const issue = parts.map((part) => {
    if (part.kind === "fixed") {
      return (
        <span key={`${part.kind}-${part.text}`} data-ref-part="fixed">
          {part.text}
        </span>
      );
    }
    const allocation = active?.segments[segmentIndex++];
    const chars = Array.from(part.text);
    const tailCount = allocation?.tailCount ?? 1;
    return (
      <span
        key={`${part.kind}-${part.text}`}
        data-comment-segment={part.kind}
        data-comment-clipped={allocation?.clipped || undefined}
        className="comment-reference-segment"
      >
        <span
          data-ref-part={part.kind}
          className="comment-reference-head"
          style={
            allocation?.clipped
              ? { width: Math.max(0, allocation.width - allocation.tailWidth) }
              : undefined
          }
        >
          {chars.slice(0, -tailCount).join("")}
        </span>
        <span data-ref-part={part.kind}>
          {chars.slice(-tailCount).join("")}
        </span>
      </span>
    );
  });
  const comment = <span data-ref-part="fixed">{suffix}</span>;
  const titleNode =
    shownTitle === null ? null : (
      <span
        data-comment-title
        className={
          inBody
            ? `comment-reference-title truncate${capTitle ? " max-w-[24em]" : ""}`
            : "font-medium text-foreground"
        }
        style={
          active
            ? {
                maxWidth: capTitle
                  ? `min(24em, ${active.available}px)`
                  : active.available,
              }
            : undefined
        }
      >
        {shownTitle}
      </span>
    );
  const decoration = <span data-comment-decoration>{" · "}</span>;
  return (
    <span ref={root} className={inBody ? "comment-reference-body" : undefined}>
      <span
        data-comment-ref
        data-comment-wrap={active?.wrap || undefined}
        data-comment-has-title={shownTitle !== null || undefined}
        className="font-normal text-muted-foreground"
      >
        {titleNode && !refLeads ? (
          <>
            {titleNode}
            {decoration}
          </>
        ) : null}
        <span className="comment-reference-identity">
          {issue}
          {titleNode && refLeads ? null : comment}
        </span>
        {titleNode && refLeads ? (
          <>
            <span data-comment-decoration> </span>
            {titleNode}
            {decoration}
            <span className="comment-reference-identity">{comment}</span>
          </>
        ) : null}
      </span>
      <span data-comment-author className="font-normal text-muted-foreground">
        {` by ${author}`}
      </span>
    </span>
  );
}
