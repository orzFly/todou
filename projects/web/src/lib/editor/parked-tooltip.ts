import { Prec } from "@codemirror/state";
import { showTooltip, type Tooltip } from "@codemirror/view";

// Above every viewport, so the tooltip plugin's "outside the editor" check
// sends it back to its parking spot on every measure.
const nowhere = { top: -1e6, bottom: -1e6, left: 0, right: 0 };

const parked: Tooltip = {
  pos: 0,
  create: () => {
    const dom = document.createElement("div");
    dom.setAttribute("aria-hidden", "true");
    return { dom, getCoords: () => nowhere };
  },
};

/**
 * Keeps Safari's tooltips `position: fixed`, so the editor wrapper's
 * overflow-hidden cannot clip a completion popup.
 *
 * Safari reports no offsetParent for a fixed element, so @codemirror/view
 * detects a transformed ancestor by measuring its first tooltip and checking
 * that it still sits where it was created (top -10000px, left 0). Since
 * 6.38.7 it measures on every pass, and once that tooltip has been placed its
 * real position reads as "displaced", which switches every tooltip to
 * `absolute` for good.
 *
 * This tooltip goes first and never leaves that spot, so the measurement
 * keeps meaning what it was meant to: inside a really transformed parent (the
 * metadata dialog) it is still displaced, and the switch still happens.
 */
export const parkedTooltip = Prec.highest(showTooltip.of(parked));
