import type { Issue } from "@todou/shared";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import {
  CompactIssueIdentity,
  IssueReturnLink,
} from "@/components/shared/return-link.tsx";
import { useHeaderHeight } from "@/lib/use-header-height.ts";
import { cn } from "@/lib/utils";

/**
 * The card's one sticky row, below the shell header: the way back, always;
 * and once the real `<h1>` has scrolled away, a mirror of the card's identity
 * with the timeline's `Reveal all` at its right edge (T-407, T-154).
 *
 * One row and not two floating layers, because the two halves want opposite
 * things and a page cannot wear both bars at once. The back link has to be
 * there before the reader has scrolled anywhere, so the row is in the flow,
 * has real height and is measured for the page's scroll insets. The mirror
 * only makes sense once the heading is gone, so it fades in and out *inside*
 * that fixed height — crossing the threshold still shifts nothing the reader
 * is looking at, which is what the zero-height host this row grew out of was
 * protecting.
 */
export function IssueReturnRow({
  slug,
  issue,
  watchTarget,
  rowRef,
  mirror,
}: {
  slug: string;
  issue: Issue;
  watchTarget: RefObject<HTMLElement | null>;
  /**
   * The row, for the page's scroll insets. Unlike the bar it replaces, this
   * one is on screen at every scroll position, so its height is what every
   * comment anchor and timeline jump has to clear — not only the ones taken
   * past the threshold.
   */
  rowRef?: RefObject<HTMLDivElement | null>;
  /**
   * A control at the row's right edge. Only ever a mirror of something the
   * document still holds: it rides in the `aria-hidden` half, so a reader on
   * assistive tech has to be able to reach it in the flow.
   */
  mirror?: ReactNode;
}) {
  const headerHeight = useHeaderHeight();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const target = watchTarget.current;
    if (target === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setShown(!entry.isIntersecting),
      { rootMargin: `-${headerHeight}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [headerHeight, watchTarget]);

  return (
    <div
      ref={rowRef}
      data-testid="issue-return-row"
      // `mb-4` rather than joining the column's `space-y-4` block: this row is
      // the column's chrome, not one of its content blocks, and the block's
      // own rhythm should not decide how far it sits from the card.
      className="sticky z-30 -mx-2 mb-4 flex h-10 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur"
      style={{ top: headerHeight }}
    >
      {/* Outside the mirror in every sense that matters: a real link in the
          normal tab order, not inside the `aria-hidden` subtree, and the one
          thing on this row a click must not answer by scrolling to the top
          (T-407). */}
      <IssueReturnLink slug={slug} />
      <div
        aria-hidden
        // Opacity and `pointer-events` leave a button tabbable: without this
        // the reveal eye would sit in the tab order of a bar nobody can see,
        // between the back link and the card's own heading. Fading rather
        // than unmounting is what makes the attribute necessary.
        inert={!shown}
        data-testid="floating-title-bar"
        data-state={shown ? "shown" : "hidden"}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 transition-all duration-150",
          shown
            ? "cursor-pointer"
            : "pointer-events-none -translate-y-1 opacity-0",
        )}
        // On the half, never on the row: scroll-to-top is what this mirror
        // offers in place of the heading it replaced, and the back link beside
        // it goes somewhere else entirely.
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      >
        <CompactIssueIdentity
          slug={slug}
          number={issue.number}
          title={issue.title}
          className="flex-1"
        />
        {mirror !== undefined && <span className="shrink-0">{mirror}</span>}
      </div>
    </div>
  );
}
