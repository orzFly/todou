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

function installCanvas() {
  const rejected: string[] = [];
  const context = new Proxy<Record<string, unknown>>(
    { measureText: (text: string) => ({ width: text.length }) },
    {
      set(target, key, value) {
        const allowed = CANVAS_ENUMS[String(key)];
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
