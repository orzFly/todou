import { useLayoutEffect } from "react";

/** The version message's own ceiling, whatever room the row has (T-194). */
const VMAX = 320;

/** Kept clear between the left cluster and the right-anchored one. */
const MIN_GAP = 12;

/** Below this the recomputed value is the one already written. */
const EPSILON = 0.5;

const px = (value: number) => `${Math.max(0, Math.round(value * 10) / 10)}px`;

/**
 * Ties the baseline trigger's width to half of the version trigger's, both
 * of them still sized to their own content (T-200).
 *
 * No CSS can express this. `flex-shrink: 2` only acts once the row overflows,
 * so a short version message and a long baseline one would leave the baseline
 * trigger wider than half at every width that fits; percentages and container
 * query units resolve against an ancestor, never against a sibling's content
 * width; and `fit-content` caps each trigger without coupling them. So the
 * row is measured and two custom properties cap the message spans — JS never
 * takes over the layout, it only lowers a ceiling.
 *
 * The budget is split 2:1 only when both messages want more than they can
 * have; whichever one is short hands its slack to the other, or a 40-character
 * version message would sit truncated beside empty space.
 */
export function useLinkedTriggerWidths(
  rowRef: React.RefObject<HTMLElement | null>,
  /** What invalidates a measurement: the version, the baseline, both messages. */
  deps: unknown[],
) {
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    if (typeof ResizeObserver === "undefined") return; // happy-dom

    let lastV = Number.NaN;
    let lastB = Number.NaN;

    const measure = () => {
      const version = row.querySelector<HTMLElement>(
        '[data-linked-msg="version"]',
      );
      // Below lg both messages are display:none and the triggers are chip and
      // arrow only, which satisfies every constraint on its own.
      if (version === null || version.getClientRects().length === 0) return;
      const baseline = row.querySelector<HTMLElement>(
        '[data-linked-msg="baseline"]',
      );
      const versionTrigger = version.closest<HTMLElement>(
        "[data-linked-trigger]",
      );
      if (versionTrigger === null) return;
      const baselineTrigger =
        baseline?.closest<HTMLElement>("[data-linked-trigger]") ?? null;

      const width = (el: Element) => el.getBoundingClientRect().width;
      // The part of each trigger that is not the message: chip, chevron,
      // padding and the gaps between them. Invariant under the caps below,
      // which is what makes one pass enough.
      const vFix = width(versionTrigger) - width(version);
      const bFix =
        baselineTrigger === null || baseline === null
          ? 0
          : width(baselineTrigger) - width(baseline);
      // scrollWidth ignores the cap in force and reports what the text wants;
      // the extra pixel keeps a fitting message off its own ellipsis.
      const nv = version.scrollWidth + 1;
      const nb = baseline === null ? 0 : baseline.scrollWidth + 1;

      const children = [...row.children] as HTMLElement[];
      const fixed = children
        .filter((child) => !child.contains(versionTrigger))
        .filter(
          (child) =>
            baselineTrigger === null || !child.contains(baselineTrigger),
        )
        .reduce((sum, child) => sum + width(child), 0);
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const gaps = gap * Math.max(0, children.length - 1) + MIN_GAP;

      const budget = row.clientWidth - fixed - gaps - vFix - bFix;
      const vMsg = Math.max(
        0,
        Math.min(nv, VMAX, Math.max((budget * 2) / 3, budget - nb)),
      );
      const bMsg = Math.max(
        0,
        Math.min(nb, budget - vMsg, (vFix + vMsg) / 2 - bFix),
      );

      // The ResizeObserver's own loop breaker: writing a cap changes the row's
      // layout, which calls this back with the same numbers.
      if (
        Math.abs(vMsg - lastV) < EPSILON &&
        Math.abs(bMsg - lastB) < EPSILON
      ) {
        return;
      }
      lastV = vMsg;
      lastB = bMsg;
      row.style.setProperty("--spec-vmsg-max", px(vMsg));
      row.style.setProperty("--spec-bmsg-max", px(bMsg));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    // The display slot rotates between `fold`, `wrap` and `new in vN` without
    // the row itself changing size, and that shifts the whole budget.
    const display = row.querySelector('[data-toolbar-slot="display-toggle"]');
    if (display !== null) observer.observe(display);
    return () => observer.disconnect();
  }, [rowRef, ...deps]);
}
