import { formatRef, type Issue } from "@todou/shared";
import { type RefObject, useEffect, useState } from "react";
import { useRefPrefix } from "@/api/references.ts";
import { cn } from "@/lib/utils";

/** The shell header's desktop height, until the measurement lands. */
const FALLBACK_HEADER_HEIGHT = 56;

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
  const [headerHeight, setHeaderHeight] = useState(FALLBACK_HEADER_HEIGHT);
  const [shown, setShown] = useState(false);

  // The shell header carries a second row of nav below sm, so its height is a
  // runtime value no CSS offset can name — measure it, as the issue list's
  // group headers do.
  useEffect(() => {
    const appbar = document.querySelector("header");
    if (appbar === null) return;
    const measure = () =>
      setHeaderHeight(appbar.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(appbar);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

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
        {/* The ref sits outside the truncating span, so no title length can
            eat it — and T-153 may swap the two without changing that. */}
        <span
          className="min-w-0 truncate text-[0.9375rem] font-semibold"
          title={issue.title}
        >
          {issue.title}
        </span>
        <span className="shrink-0 text-sm text-muted-foreground">
          {formatRef(refPrefix, issue.number)}
        </span>
      </div>
    </div>
  );
}
