/**
 * Text geometry for the middle-eliding ref renderers. Two of them now read
 * the same numbers — the body's comment chip and the search rows — and a
 * second copy of the canvas set-up would let their 1/1 and 3/3 tiers drift
 * apart without either one changing.
 *
 * Nothing here knows what the measured element is for: the budget an element
 * is measured against is the caller's, and that is the part the two surfaces
 * genuinely disagree on.
 */

export const pixels = (value: string) => Number.parseFloat(value) || 0;

/** Measure the actual rendered text nodes, including their clipped characters. */
export function textWidth(element: Element, start = 0, end = Infinity): number {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    const from = Math.max(0, start - offset);
    const to = Math.min(length, end - offset);
    if (from < to) {
      range.setStart(node, from);
      range.setEnd(node, to);
      for (const rect of range.getClientRects()) width += rect.width;
    }
    offset += length;
  }
  return width;
}

const STRETCH_KEYWORDS = [
  [50, "ultra-condensed"],
  [62.5, "extra-condensed"],
  [75, "condensed"],
  [87.5, "semi-condensed"],
  [100, "normal"],
  [112.5, "semi-expanded"],
  [125, "expanded"],
  [150, "extra-expanded"],
  [200, "ultra-expanded"],
] as const;

/**
 * Rounded away from normal because CSS font matching searches that way first:
 * for a family whose faces sit at keyword widths, the keyword picks the same
 * face as the percentage. A width axis is drawn at the keyword's width instead.
 */
function stretchKeyword(computed: string): string {
  const percent = Number.parseFloat(computed);
  const [, keyword] =
    percent <= 100
      ? (STRETCH_KEYWORDS.findLast(([at]) => at <= percent) ??
        STRETCH_KEYWORDS[0])
      : (STRETCH_KEYWORDS.find(([at]) => at >= percent) ??
        STRETCH_KEYWORDS[STRETCH_KEYWORDS.length - 1]);
  return keyword;
}

/**
 * CSSOM serializes `font` as "" once any longhand the shorthand cannot spell
 * is set, and canvas ignores "" for its default 10px sans-serif. Canvas has no
 * setting for most of those (`tabular-nums`, `font-feature-settings`, …), so
 * they measure as if unset; size, family, weight and width still come through.
 */
function canvasFont(style: CSSStyleDeclaration): string {
  if (style.font) return style.font;
  return [
    style.fontStyle,
    style.fontWeight,
    stretchKeyword(style.fontStretch),
    style.fontSize,
    style.fontFamily,
  ]
    .filter((part) => part !== "normal")
    .join(" ");
}

/**
 * Text advance in an element's own computed font, or `null` where there is no
 * canvas (happy-dom). Canvas creates neither a DOM text copy nor a second
 * selectable identity.
 */
export function canvasMeasurer(
  element: Element,
): ((text: string) => number) | null {
  const style = getComputedStyle(element);
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  // No fontStretch among these: computed style spells it as a percentage,
  // which canvas's keyword-only attribute drops with a console warning
  // (T-822), and `font` already carries every width a keyword can name.
  context.font = canvasFont(style);
  context.fontKerning = style.fontKerning as CanvasFontKerning;
  context.fontVariantCaps = style.fontVariantCaps as CanvasFontVariantCaps;
  context.textRendering = style.textRendering as CanvasTextRendering;
  context.letterSpacing =
    style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
  context.wordSpacing =
    style.wordSpacing === "normal" ? "0px" : style.wordSpacing;
  return (text) => context.measureText(text).width;
}

function segmentMeasurer(element: Element, text: string) {
  // A clipped DOM Range can report both the full text and an extra visual
  // ellipsis fragment. Measuring the original substrings on canvas avoids
  // counting that decoration and keeps 1/3 tail changes independent of layout.
  const canvas = canvasMeasurer(element);
  return {
    width(start = 0, end = text.length) {
      return canvas
        ? canvas(text.slice(start, end))
        : textWidth(element, start, end);
    },
    ellipsis: canvas?.("…") ?? pixels(getComputedStyle(element).fontSize),
  };
}

export type SegmentMetrics = {
  /** Width of the complete original segment, measured in CSS pixels. */
  full: number;
  /** First character + native ellipsis + last character (or full if shorter). */
  minimum: number;
  /** The one trailing character the 1/1 tier keeps outside the clipped head. */
  tailWidth: number;
  /** Three characters each side, or `Infinity` where that saves nothing. */
  threeWidth: number;
  /** The three trailing characters the 3/3 tier keeps. */
  tailThreeWidth: number;
};

/**
 * What `allocateCommentRef` needs about one elidable run, measured in the
 * styles it is actually rendered in.
 *
 * Counted in code points rather than UTF-16 units, so an astral character is
 * one glyph to keep rather than half of a broken pair.
 */
export function segmentMetrics(
  element: Element,
  text = element.textContent ?? "",
): SegmentMetrics {
  const chars = Array.from(text);
  const first = chars[0]?.length ?? 0;
  const last = chars.at(-1)?.length ?? 0;
  const measured = segmentMeasurer(element, text);
  const full = measured.width();
  const ellipsis = measured.ellipsis;
  const tailWidth = measured.width(text.length - last);
  const headThree = chars.slice(0, 3).join("").length;
  const tailThree = chars.slice(-3).join("").length;
  return {
    full,
    minimum:
      chars.length < 3
        ? full
        : Math.min(full, measured.width(0, first) + ellipsis + tailWidth),
    tailWidth,
    threeWidth:
      chars.length > 6
        ? measured.width(0, headThree) +
          ellipsis +
          measured.width(text.length - tailThree)
        : Infinity,
    tailThreeWidth: measured.width(text.length - tailThree),
  };
}
