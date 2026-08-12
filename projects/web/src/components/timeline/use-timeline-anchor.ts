import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  anchorElementId,
  parseTimelineAnchor,
} from "@/lib/timeline-anchors.ts";

type TimelineQueryLike = {
  hasPreviousPage: boolean;
  isFetchingPreviousPage: boolean;
  fetchPreviousPage: (opts?: { cancelRefetch?: boolean }) => unknown;
};

/** One-shot highlight; restartable when the same anchor is re-targeted. */
function flash(el: HTMLElement) {
  el.classList.remove("anchor-flash");
  // Reflow so removing+adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add("anchor-flash");
  el.addEventListener(
    "animationend",
    () => el.classList.remove("anchor-flash"),
    { once: true },
  );
}

/**
 * Drive `#comment-<id>` / `#event-<id>` anchors (#38): once the target is
 * rendered, center it and flash a highlight; while it isn't, keep loading
 * older timeline pages (newest page loads first, so a permalink target is
 * usually further up).
 *
 * 「#30 seam」 When the timeline stops rendering everything (head/tail
 * with a folded middle), replace the fetch-older loop below with "expand
 * the chunk containing the target" — the anchor → element contract
 * (anchorElementId) and the scroll+flash step stay as they are.
 *
 * Returns whether an anchor is being targeted, so the caller can skip its
 * default scroll-to-bottom.
 */
export function useTimelineAnchor(timeline: TimelineQueryLike): boolean {
  const hash = useRouterState({ select: (s) => s.location.hash });
  const target = parseTimelineAnchor(hash ?? "");
  const doneFor = useRef<string | null>(null);

  // Deliberately dependency-free: every render re-checks whether the
  // target exists yet — item prepends, fetch settles, and hash changes
  // all surface as renders, and the guards make re-runs cheap.
  useEffect(() => {
    if (!target) return;
    const key = anchorElementId(target);
    if (doneFor.current === key) return;
    const el = document.getElementById(key);
    if (el) {
      doneFor.current = key;
      // Center, so neither the sticky composer nor the viewport edge
      // covers the target.
      el.scrollIntoView({ block: "center" });
      flash(el);
    } else if (timeline.hasPreviousPage && !timeline.isFetchingPreviousPage) {
      // A dead anchor (deleted comment, foreign event id) degrades to
      // loading the full timeline and staying at the top — acceptable
      // until #30 bounds it.
      timeline.fetchPreviousPage({ cancelRefetch: false });
    }
  });

  return target !== null;
}
