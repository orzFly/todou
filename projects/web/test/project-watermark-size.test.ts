import { describe, expect, it } from "vitest";
import {
  watermarkClearance,
  watermarkFontSize,
} from "../src/components/shared/ref-watermark.tsx";

/** A prefix of exactly `n` characters, in the real charset. */
const of = (n: number) => "W".repeat(n);

describe("the watermark's size bands", () => {
  it("holds the largest size through three characters", () => {
    expect(watermarkFontSize(of(1))).toBe("3.25rem");
    expect(watermarkFontSize(of(3))).toBe("3.25rem");
  });

  it("steps down at four", () => {
    expect(watermarkFontSize(of(4))).toBe("2.25rem");
    expect(watermarkFontSize(of(6))).toBe("2.25rem");
  });

  it("steps down again at seven", () => {
    expect(watermarkFontSize(of(7))).toBe("1.5rem");
    expect(watermarkFontSize(of(12))).toBe("1.5rem");
  });

  it("steps down a last time at thirteen", () => {
    expect(watermarkFontSize(of(13))).toBe("1rem");
  });

  it("puts the longest prefix the pattern allows in the last band", () => {
    // `[A-Z][A-Z0-9_]{0,19}` tops out at 20.
    expect(watermarkFontSize(of(20))).toBe("1rem");
  });
});

/**
 * What a watermark of `n` widest characters actually measures, in rem, in the
 * app's own font (Geist Variable, 700, -0.05em tracking). Taken off a clone
 * of the real watermark element in Chrome at each length's own band size —
 * `W` is the widest of `[A-Z0-9_]`.
 *
 * These are observations, not derivations: the clearance is computed from a
 * per-character constant, so checking it against numbers derived from that
 * same constant would prove nothing. The dips at 4, 7 and 13 are the band
 * edges, where the type shrinks faster than the prefix grows.
 */
const MEASURED_REM = [
  3.1367, 6.2402, 9.3447, 8.6182, 10.7666, 12.915, 10.043, 11.4756, 12.9082,
  14.3408, 15.7725, 17.2051, 12.4258, 13.3809, 14.3359, 15.291, 16.2451,
  17.2002, 18.1553, 19.1104,
];

/** `padding-right` plus the header inset the description starts inside of. */
const reachOf = (prefix: string) =>
  Number.parseFloat(watermarkClearance(prefix)) + 0.25;

describe("the room a watermark makes the card's text leave it", () => {
  it("reserves nothing on a card that has no watermark", () => {
    expect(watermarkClearance(null)).toBe("");
    expect(watermarkClearance("")).toBe("");
  });

  it("clears the real width at every length the pattern allows", () => {
    // The bug this replaces: the reserve was sized off an average glyph, so
    // `WMS` overlapped its own watermark by 9.7px and `WWW` by 33.5px, while
    // the `CH` used for acceptance looked fine.
    MEASURED_REM.forEach((width, i) => {
      expect(reachOf(of(i + 1)), `${i + 1}×W`).toBeGreaterThanOrEqual(width);
    });
  });

  it("charges a short prefix only for its own width", () => {
    // A two-character REF is the common case and has no business paying for
    // the twenty-character one its band never contains.
    expect(reachOf(of(2))).toBeLessThan(reachOf(of(3)));
    expect(reachOf(of(20))).toBeGreaterThan(reachOf(of(2)));
  });

  it("grows with each extra character inside a band", () => {
    // Only inside one: at a band edge the type drops a size, so a longer
    // prefix is genuinely narrower — 4 characters at 2.25rem take less room
    // than 3 at 3.25rem, and the reserve follows the mark, not the length.
    for (const [lo, hi] of [
      [1, 3],
      [4, 6],
      [7, 12],
      [13, 20],
    ] as const) {
      for (let n = lo; n < hi; n++) {
        expect(reachOf(of(n + 1)), `at ${n}`).toBeGreaterThan(reachOf(of(n)));
      }
    }
  });
});
