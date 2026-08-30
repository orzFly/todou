import { formatRef, type Issue } from "@todou/shared";
import { type RefObject, useEffect, useState } from "react";
import { useRefPlacement } from "@/api/prefs.ts";
import { useRefPrefix } from "@/api/references.ts";
import { useHeaderHeight } from "@/lib/use-header-height.ts";
import { cn } from "@/lib/utils";

/**
 * The issue title, floating below the shell header once the real title
 * scrolls out of view (T-154). Hidden from assistive tech: the heading it
 * mirrors stays in the document, and scroll-to-top is reachable without it.
 */
export function FloatingTitleBar({
  slug,
  issue,
  watchTarget,
}: {
  slug: string;
  issue: Issue;
  watchTarget: RefObject<HTMLElement | null>;
}) {
  const refPrefix = useRefPrefix(slug);
  const refLeads = useRefPlacement("detail") === "before";
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
    // Zero-height host: the bar never enters the flow, so crossing the
    // threshold shifts nothing the reader is looking at.
    <div className="sticky z-30 h-0" style={{ top: headerHeight }}>
      <div
        aria-hidden
        data-testid="floating-title-bar"
        data-state={shown ? "shown" : "hidden"}
        className={cn(
          "-mx-2 flex h-10 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur transition-all duration-150",
          shown
            ? "cursor-pointer"
            : "pointer-events-none -translate-y-1 opacity-0",
        )}
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      >
        {/* Either order, the ref stays outside the truncating span, so no
            title length can eat it. */}
        {refLeads && (
          <span className="shrink-0 text-sm text-muted-foreground">
            {formatRef(refPrefix, issue.number)}
          </span>
        )}
        <span
          className="min-w-0 truncate text-[0.9375rem] font-semibold"
          title={issue.title}
        >
          {issue.title}
        </span>
        {!refLeads && (
          <span className="shrink-0 text-sm text-muted-foreground">
            {formatRef(refPrefix, issue.number)}
          </span>
        )}
      </div>
    </div>
  );
}
