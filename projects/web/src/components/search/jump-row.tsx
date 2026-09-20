import { Fragment, useLayoutEffect, useRef, useState } from "react";
import {
  allocateCommentRef,
  type RefIdentity,
  refTokenParts,
} from "@/lib/comment-ref-layout.ts";
import { pixels, segmentMetrics } from "@/lib/ref-text-metrics.ts";
import { cn } from "@/lib/utils";

type Elision = {
  width: number;
  tailWidth: number;
  tailCount: number;
  clipped: boolean;
};

type Layout = { segments: Elision[]; wrap: boolean };

/** What stands between `· by` and the name, and never gives any width up. */
const BY = "· by ";

/**
 * One elided run of a ref token or of an author's name: a fixed-width head
 * carrying the browser's own ellipsis, then the last character or three.
 *
 * Only ever rendered for a run the allocator actually clipped. A row with room
 * for its ref keeps one text node per element, exactly as it had before any of
 * this existed, which is what lets "short refs are untouched" be checked as
 * literal geometry rather than as a resemblance.
 */
function Segment({
  text,
  allocation,
  wrap,
}: {
  text: string;
  allocation: Elision | undefined;
  wrap: boolean;
}) {
  if (allocation === undefined || !allocation.clipped) return text;
  const chars = Array.from(text);
  return (
    <span
      className={
        wrap
          ? "[overflow-wrap:anywhere]"
          : "inline-block align-baseline whitespace-nowrap"
      }
    >
      <span
        className="inline-block overflow-hidden align-bottom text-ellipsis whitespace-nowrap"
        style={{ width: Math.max(0, allocation.width - allocation.tailWidth) }}
      >
        {chars.slice(0, -allocation.tailCount).join("")}
      </span>
      <span>{chars.slice(-allocation.tailCount).join("")}</span>
    </span>
  );
}

/**
 * The inside of a search row that leads with a ref token — the offer panel's
 * rows and the search page's jump banner, which show the same four kinds of
 * row and used to share only their shape.
 *
 * Every one of them had exactly one thing that could give width up, the title
 * in the middle, and a 97-character ref beside it drove that title to 0px and
 * then kept going: 925px of page off the side of the banner, and 972px of row
 * out of reach inside the panel, where the panel's own `overflow-y-auto` turns
 * the overflow horizontal and hides it instead (T-446). So the token elides in
 * the middle like the body's comment chip does, through the same allocator —
 * and the author beside it elides too, which the body forbids: at 390px the
 * name is the single largest claim on the line, and a row where it cannot
 * yield has no arrangement at all.
 *
 * The complete spelling stays in `title`. There is no copy affordance here on
 * purpose: a reader looking at one of these rows typed the ref into the box
 * themselves, or arrived through a `?q=` that still holds it.
 *
 * The caller keeps its own row element, its link semantics and its icon; this
 * is only what goes inside.
 */
export function JumpRowBody({
  icon,
  spelled,
  identity,
  refClassName,
  lead,
  text,
  textClassName,
  author = null,
  trailing,
}: {
  /** The row's leading glyph, or the blank box a row uses in its place. */
  icon: React.ReactNode;
  /** The token as written, which is also what hovering it reveals. */
  spelled: string;
  /** The card it names, where one is known; `null` elides the token whole. */
  identity: RefIdentity | null;
  refClassName?: string;
  /**
   * One unshrinkable element between the token and the text — the project
   * icon. Its measured width comes off the budget, so it has to be a single
   * element rather than a fragment.
   */
  lead?: React.ReactNode;
  /** The middle column: a card's title, a project's name, a link's host. */
  text: React.ReactNode;
  textClassName?: string;
  /** Who wrote the comment, for the rows that name one. */
  author?: string | null;
  /** The status pill, where the row carries one. */
  trailing?: React.ReactNode;
}) {
  const block = useRef<HTMLSpanElement>(null);
  const token = useRef<HTMLSpanElement>(null);
  const credit = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const parts = refTokenParts(spelled, identity);
  // Every call site builds its identity inline, so the parts are a new array
  // on each render and cannot themselves say whether the token changed.
  const signature = parts.map((part) => `${part.kind}:${part.text}`).join(" ");

  // The runs are measured against the elements they are rendered in, not read
  // back out of them: a run that is already elided has lost the characters the
  // next allocation has to weigh, so the widths come off the original strings.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token and the author are the measurement inputs.
  useLayoutEffect(() => {
    const element = block.current;
    if (element === null) return;
    let disposed = false;
    const measure = () => {
      const styled = token.current;
      // The row is laid out by flex, so this box is the leftover after the
      // icon, the gaps around it and the status pill have been paid for —
      // which is the whole budget, and the reason none of it is a constant.
      if (disposed || styled === null || element.clientWidth === 0) return;
      const children = [...element.children];
      const gap = pixels(getComputedStyle(element).columnGap);
      const reserved = children
        .filter((child) => !child.hasAttribute("data-jump-part"))
        .reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
      const available = Math.max(
        0,
        element.clientWidth - gap * Math.max(0, children.length - 1) - reserved,
      );
      const named = credit.current;
      const metrics = [
        ...parts
          .filter((part) => part.kind !== "fixed")
          .map((part) => segmentMetrics(styled, part.text)),
        ...(named === null || author === null
          ? []
          : [segmentMetrics(named, author)]),
      ];
      const fixed =
        parts
          .filter((part) => part.kind === "fixed")
          .reduce(
            (sum, part) => sum + segmentMetrics(styled, part.text).full,
            0,
          ) + (named === null ? 0 : segmentMetrics(named, BY).full);
      // happy-dom has no text geometry. Leave its original DOM intact; only
      // real measurements (or deliberate test doubles) drive allocation.
      if (fixed === 0 && metrics.every(({ full }) => full === 0)) return;
      const allocation = allocateCommentRef(available, fixed, metrics);
      const next: Layout = {
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
    observer?.observe(element);
    window.addEventListener("resize", measure);
    document.fonts?.addEventListener("loadingdone", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [signature, author]);

  const wrap = layout?.wrap ?? false;
  const runs = parts.filter((part) => part.kind !== "fixed").length;
  const elided =
    layout?.segments.slice(0, runs).some(({ clipped }) => clipped) ?? false;
  const credited = layout?.segments[runs];

  let run = 0;
  return (
    <>
      {icon}
      {/* Wrapping is the last resort under the elision, and it is switched on
          only once the allocator says the line cannot close — never left on.
          Flex breaks lines by each item's *content* width before anything
          shrinks, so a standing `flex-wrap` sends the title to a row of its
          own the moment it is longer than the space left, instead of letting
          it give that space up, which is the one thing every row here has
          always done. `items-center` matches the row's own, so an unelided
          row sits exactly where it always did. */}
      <span
        ref={block}
        data-jump-row
        className={cn(
          "flex min-w-0 flex-1 items-center gap-x-2",
          wrap && "flex-wrap",
        )}
      >
        <span
          ref={token}
          data-jump-part
          title={spelled}
          className={cn(
            "font-mono text-xs",
            // What `shrink-0` used to buy, without refusing to shrink: a ref
            // is full of hyphens and slashes, every one of them a break
            // opportunity, so a token that may shrink breaks itself across two
            // lines the moment the title stops covering for it. The allocated
            // head widths are what this row narrows by; the text itself stays
            // on one line until the allocator says no one line will do.
            wrap ? "[overflow-wrap:anywhere]" : "whitespace-nowrap",
            refClassName,
          )}
        >
          {elided
            ? parts.map((part, at) =>
                part.kind === "fixed" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the token is rebuilt whole, so position is its identity.
                  <Fragment key={at}>{part.text}</Fragment>
                ) : (
                  <Segment
                    // biome-ignore lint/suspicious/noArrayIndexKey: the token is rebuilt whole, so position is its identity.
                    key={at}
                    text={part.text}
                    allocation={layout?.segments[run++]}
                    wrap={wrap}
                  />
                ),
              )
            : spelled}
        </span>
        {lead}
        <span data-jump-part className={cn("truncate", textClassName)}>
          {text}
        </span>
        {author !== null && (
          <span
            ref={credit}
            data-jump-part
            className="whitespace-nowrap text-muted-foreground"
          >
            {BY}
            <Segment text={author} allocation={credited} wrap={wrap} />
          </span>
        )}
      </span>
      {trailing}
    </>
  );
}
