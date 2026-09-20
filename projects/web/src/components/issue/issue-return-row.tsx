import type { Issue } from "@todou/shared";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import {
  CompactIssueIdentity,
  IssueReturnLink,
} from "@/components/shared/return-link.tsx";
import { useHeaderHeight } from "@/lib/use-header-height.ts";
import { SM_UP, useMediaQuery, XL_UP } from "@/lib/use-media-query.ts";
import { cn } from "@/lib/utils";

/**
 * The title mirror, which appears once the real heading has scrolled away and
 * reserves no space until it does.
 *
 * It holds a copy of the back control too (T-461): the real one travels with
 * the heading and leaves with it, so without this copy a reader who has
 * scrolled has nothing to go back with. Not on a phone, where the header's own
 * nav keeps a back control pinned at every scroll position and a second one
 * here would put two arrows on screen at once.
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
   * Measure the inner row, which keeps its height even when the wide-screen
   * host takes no space, so timeline jumps still clear the title mirror.
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
  const carriesBack = useMediaQuery(SM_UP);
  // The mirror follows the heading it stands in for, gutter and all (T-476):
  // the copy hanging inside the bar while the original hung outside it made
  // the arrow jump sideways at the moment the two swapped over.
  const backFloats = useMediaQuery(XL_UP);
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
    // Zero-height at every width since T-461 moved the back control out: with
    // nothing left that is visible before the heading scrolls, a reserved row
    // was 2.5rem of blank pushing the card down on arrival.
    <div className="sticky z-30 -mx-2 h-0" style={{ top: headerHeight }}>
      <div
        ref={rowRef}
        data-testid="issue-return-row"
        className={cn(
          "pointer-events-none relative flex h-10 items-center gap-2 px-2",
          shown && "border-b bg-background/95 backdrop-blur",
        )}
      >
        <div
          aria-hidden
          // Opacity and `pointer-events` leave a button tabbable: without this
          // the reveal eye and the back copy would sit in the tab order of a
          // bar nobody can see. Fading rather than unmounting is what makes
          // the attribute necessary. What `aria-hidden` costs is nothing here:
          // everything in this bar is a copy of something the document still
          // holds further up the page, reachable by tab and by screen reader
          // whether or not it is in view.
          inert={!shown}
          data-testid="floating-title-bar"
          data-state={shown ? "shown" : "hidden"}
          // `relative` is what the gutter copy hangs off, and it has to be
          // written rather than inherited: this half's left edge is the text
          // column's, while the row around it is `-mx-2` and would put the
          // arrow 8px further out. The hidden state's `-translate-y-1` makes a
          // containing block of its own, so without this the arrow would
          // measure from a different box in each of the two states.
          className={cn(
            "relative flex min-w-0 flex-1 items-center gap-2 transition-all duration-150",
            shown
              ? "pointer-events-auto cursor-pointer"
              : "pointer-events-none -translate-y-1 opacity-0",
          )}
          // On the half, never on the row: scroll-to-top is what this mirror
          // offers in place of the heading it replaced. The two controls it
          // carries go somewhere else entirely and stop the click here
          // themselves, which is the arrangement the reveal eye already used.
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          {carriesBack && (
            <IssueReturnLink
              slug={slug}
              scale="compact"
              mirrored
              floating={backFloats}
            />
          )}
          <CompactIssueIdentity
            slug={slug}
            number={issue.number}
            title={issue.title}
            className="flex-1"
          />
          {mirror !== undefined && <span className="shrink-0">{mirror}</span>}
        </div>
      </div>
    </div>
  );
}
