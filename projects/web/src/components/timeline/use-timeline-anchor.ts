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
  /** Initial reads settled; a paging error is not evidence of deletion. */
  ready?: boolean;
  failed?: boolean;
};

type AnchorRequest = {
  id: number;
  onComplete: () => void;
  onUnavailable: () => void;
  onStalled: () => void;
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
export function useTimelineAnchor(
  gap: GapExpansion,
  request?: AnchorRequest,
): boolean {
  const hash = useRouterState({ select: (s) => s.location.hash });
  const target = parseTimelineAnchor(hash ?? "");
  const doneFor = useRef<string | null>(null);
  const stall = useRef<{ key: string; remaining: number } | null>(null);

  // Every render re-checks after pages, hidden runs, and hash changes.
  useEffect(() => {
    if (!target) {
      doneFor.current = null;
      stall.current = null;
      return;
    }
    const elementId = anchorElementId(target);
    const key = `${elementId}:${request?.id ?? "direct"}`;
    if (doneFor.current === key) return;
    if (request && (!gap.ready || gap.isExpanding)) return;
    const el = document.getElementById(elementId);
    if (el) {
      doneFor.current = key;
      // Reveal uses the existing floating-bar/composer scroll insets.
      revealBlock(el);
      request?.onComplete();
      return;
    }
    const run =
      target.kind === "comment"
        ? (gap.hiddenRunHolding?.(target.id) ?? null)
        : null;
    if (run !== null) {
      gap.revealRun?.(run);
    } else if (gap.failed) {
      // Let the existing timeline Retry resume this cursor.
      stall.current = null;
    } else if (!gap.isExpanding) {
      if (gap.remaining > 0) {
        if (
          stall.current?.key === key &&
          stall.current.remaining === gap.remaining
        ) {
          if (gap.ready) request?.onStalled();
          return;
        }
        stall.current = { key, remaining: gap.remaining };
        gap.expand();
      } else if (gap.ready) {
        request?.onUnavailable();
      }
    }
  });

  return target !== null;
}
