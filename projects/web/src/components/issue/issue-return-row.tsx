import type { Issue } from "@todou/shared";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import {
  CompactIssueIdentity,
  IssueReturnLink,
} from "@/components/shared/return-link.tsx";
import { useHeaderHeight } from "@/lib/use-header-height.ts";
import { cn } from "@/lib/utils";

/**
 * The return link floats in the main container's left gutter on wide screens.
 * Its sticky host reserves no space there; the title mirror only becomes
 * visible after the real heading scrolls away. Narrow screens keep an inline
 * row because there is no gutter for the link.
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
      className="sticky z-30 -mx-2 mb-4 h-10 min-[1440px]:mb-0 min-[1440px]:h-0"
      style={{ top: headerHeight }}
    >
      <div
        ref={rowRef}
        data-testid="issue-return-row"
        className={cn(
          "pointer-events-none relative flex h-10 items-center gap-2 px-2",
          shown && "border-b bg-background/95 backdrop-blur",
        )}
      >
        <IssueReturnLink slug={slug} floating />
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
              ? "pointer-events-auto cursor-pointer"
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
    </div>
  );
}
