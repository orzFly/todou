import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  anchorElementId,
  parseTimelineAnchor,
} from "@/lib/timeline-anchors.ts";

/** What the anchor needs from the folded timeline (T-30). */
export type GapExpansion = {
  /** Items still folded between head and tail (0 = nothing left to load). */
  remaining: number;
  isExpanding: boolean;
  expand: () => void;
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
 * Drive `#comment-<id>` / `#event-<id>` anchors (T-38): once the target is
 * rendered, center it and flash a highlight; while it isn't, expand the
 * folded middle (T-30) one chunk at a time from the gap's head side until
 * the target's chunk is in. The anchor → element contract (anchorElementId)
 * and the scroll+flash step stay as they were.
 *
 * Returns whether an anchor is being targeted, so the caller can skip its
 * default scroll-to-bottom.
 */
export function useTimelineAnchor(gap: GapExpansion): boolean {
  const hash = useRouterState({ select: (s) => s.location.hash });
  const target = parseTimelineAnchor(hash ?? "");
  const doneFor = useRef<string | null>(null);
  // The remaining count as of the last expansion this target triggered.
  const stall = useRef<{ key: string; remaining: number } | null>(null);

  // Deliberately dependency-free: every render re-checks whether the
  // target exists yet — chunk inserts, fetch settles, and hash changes
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
    } else if (gap.remaining > 0 && !gap.isExpanding) {
      // A dead anchor (deleted comment, foreign event id) expands at most
      // the whole gap — bounded, unlike the pre-T-30 load-everything walk.
      // Stop early if an expansion failed to shrink the gap (server
      // anomaly); anything else would loop forever.
      if (
        stall.current?.key === key &&
        stall.current.remaining === gap.remaining
      ) {
        return;
      }
      stall.current = { key, remaining: gap.remaining };
      gap.expand();
    }
  });

  return target !== null;
}
