import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasMeasurer } from "../src/lib/ref-text-metrics.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Canvas's text attributes are IDL enums: a browser drops any other string
 * with a console warning and keeps the value it had. This double rejects the
 * same strings, so an attribute copied straight from computed style fails
 * here the way it warns in Chromium (T-822).
 */
const CANVAS_ENUMS: Record<string, readonly string[]> = {
  fontKerning: ["auto", "normal", "none"],
  fontStretch: [
    "ultra-condensed",
    "extra-condensed",
    "condensed",
    "semi-condensed",
    "normal",
    "semi-expanded",
    "expanded",
    "extra-expanded",
    "ultra-expanded",
  ],
  fontVariantCaps: [
    "normal",
    "small-caps",
    "all-small-caps",
    "petite-caps",
    "all-petite-caps",
    "unicase",
    "titling-caps",
  ],
  textRendering: [
    "auto",
    "optimizeSpeed",
    "optimizeLegibility",
    "geometricPrecision",
  ],
};

/**
 * Each character advances by the font size the canvas holds, so text measured
 * in canvas's default font comes out at 10px a character.
 */
function installCanvas() {
  const rejected: string[] = [];
  const context = new Proxy<Record<string, unknown>>(
    {
      font: "10px sans-serif",
      measureText(this: { font: string }, text: string) {
        const size = Number.parseFloat(this.font.match(/[\d.]+px/)?.[0] ?? "");
        return { width: text.length * size };
      },
    },
    {
      set(target, key, value) {
        const allowed = CANVAS_ENUMS[String(key)];
        // Canvas keeps its current font when the new one does not parse.
        if (key === "font" && value === "") return true;
        if (allowed && !allowed.includes(value)) {
          rejected.push(`${String(key)} = ${value}`);
        } else {
          target[String(key)] = value;
        }
        return true;
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return { context, rejected };
}

/** What Chromium 156 and Firefox 153 compute: font-stretch as a percentage. */
const CHIP_STYLE = {
  fontKerning: "auto",
  fontVariantCaps: "normal",
  textRendering: "auto",
  letterSpacing: "normal",
  wordSpacing: "normal",
};

describe("canvasMeasurer", () => {
  it.each([
    {
      width: "the normal width",
      font: '500 14px / 22.4px "Noto Sans Variable", sans-serif',
      fontStretch: "100%",
    },
    {
      width: "a condensed width",
      font: 'condensed 500 14px / 22.4px "Noto Sans Variable", sans-serif',
      fontStretch: "75%",
    },
  ])(
    "hands the canvas only values it accepts, at $width",
    ({ font, fontStretch }) => {
      vi.stubGlobal("getComputedStyle", () => ({
        ...CHIP_STYLE,
        font,
        fontStretch,
      }));
      const { context, rejected } = installCanvas();

      expect(canvasMeasurer(document.createElement("span"))).not.toBeNull();
      expect(rejected).toEqual([]);
      // The shorthand is what carries the width to the canvas.
      expect(context.font).toBe(font);
    },
  );
});

/**
 * What Chromium 156 and Firefox 153 compute for a chip whose font a shorthand
 * cannot spell: `font` is "", and only the longhands still carry it.
 */
const UNSPELLED = {
  ...CHIP_STYLE,
  font: "",
  fontStyle: "italic",
  fontWeight: "500",
  fontStretch: "100%",
  fontSize: "14px",
  fontFamily: '"Noto Sans Variable", sans-serif',
  fontVariantNumeric: "tabular-nums",
};

describe("canvasMeasurer where the computed font shorthand is empty", () => {
  it("measures in the element's own size and family", () => {
    vi.stubGlobal("getComputedStyle", () => UNSPELLED);
    const { context, rejected } = installCanvas();

    const measure = canvasMeasurer(document.createElement("span"));

    expect(measure?.("1234")).toBe(4 * 14);
    expect(context.font).toBe(
      'italic 500 14px "Noto Sans Variable", sans-serif',
    );
    expect(rejected).toEqual([]);
  });

  it.each([
    { fontStretch: "40%", keyword: "ultra-condensed" },
    { fontStretch: "50%", keyword: "ultra-condensed" },
    { fontStretch: "80%", keyword: "condensed" },
    { fontStretch: "95%", keyword: "semi-condensed" },
    { fontStretch: "100%", keyword: null },
    { fontStretch: "105%", keyword: "semi-expanded" },
    { fontStretch: "120%", keyword: "expanded" },
    { fontStretch: "250%", keyword: "ultra-expanded" },
  ])(
    "names a $fontStretch width by the keyword away from normal: $keyword",
    ({ fontStretch, keyword }) => {
      vi.stubGlobal("getComputedStyle", () => ({
        ...UNSPELLED,
        fontStyle: "normal",
        fontWeight: "400",
        fontStretch,
        fontFamily: "Probe",
      }));
      const { context } = installCanvas();

      canvasMeasurer(document.createElement("span"));

      expect(context.font).toBe(
        ["400", keyword, "14px Probe"].filter(Boolean).join(" "),
      );
    },
  );
});
