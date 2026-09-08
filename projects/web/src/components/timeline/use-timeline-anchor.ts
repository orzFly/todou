import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { revealBlock } from "@/lib/scroll-insets.ts";
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
  /**
   * The revealed-run key holding this comment id, if a loaded run does
   * (T-281). Null when no run holds it — it may be visible already, or
   * still behind the paging gap.
   */
  hiddenRunHolding?: (commentId: number) => string | null;
  /** Open that run, so the target renders on the next pass. */
  revealRun?: (key: string) => void;
};

/**
 * Drive `#comment-<id>` / `#event-<id>` anchors (T-38): once the target is
 * rendered, reveal it and flash a highlight; while it isn't, expand the
 * folded middle (T-30) one chunk at a time from the gap's head side until
 * the target's chunk is in. The anchor → element contract (anchorElementId)
 * stays as it was.
 *
 * A hidden run is the second reason a target may not be rendered (T-281),
 * and it is checked before the paging gap: the placeholder does not show
 * the ids it stands for, so a permalink followed from elsewhere would land
 * on a line that says nothing about where its target went.
 *
 * The two channels chain without any coordination between them. A comment
 * that is both unloaded and hidden arrives through the gap expansion first,
 * becomes a placeholder, and is opened by the run channel on a later pass —
 * this effect has no dependency array and re-decides every render.
 *
 * Revealing needs no `stall` guard the way expanding does: a run that is
 * open stays open, so the check cannot ask for the same thing twice.
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
      // Centred while it fits between the floating bar and the composer,
      // top-aligned once it is taller than what they leave — a long comment
      // centred puts its author line hundreds of pixels off screen (T-299).
      // The strip itself comes from the page's `scroll-padding`.
      revealBlock(el);
      return;
    }
    const run =
      target.kind === "comment"
        ? (gap.hiddenRunHolding?.(target.id) ?? null)
        : null;
    if (run !== null) {
      gap.revealRun?.(run);
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
