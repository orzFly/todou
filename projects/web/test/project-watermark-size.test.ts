import { describe, expect, it } from "vitest";
import {
  watermarkClearance,
  watermarkFontSize,
} from "../src/components/shared/ref-watermark.tsx";

/** A prefix of exactly `n` characters, in the real charset. */
const of = (n: number) => "C".repeat(n);

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

describe("the room a watermark makes the card's text leave it", () => {
  it("reserves nothing on a card that has no watermark", () => {
    expect(watermarkClearance(null)).toBe("");
  });

  it("reserves more as the prefix gets wider", () => {
    // A longer prefix is set smaller but still ends up wider, so the reserve
    // has to grow with it or the description runs underneath.
    const reserves = [1, 4, 7, 13].map((n) => watermarkClearance(of(n)));
    expect(new Set(reserves).size).toBe(4);
    const px = reserves.map((c) => Number(c.replace("pr-", "")));
    expect(px).toEqual([...px].sort((a, b) => a - b));
  });

  it("gives every band a reserve", () => {
    for (let n = 1; n <= 20; n++) {
      expect(watermarkClearance(of(n)), `length ${n}`).toMatch(/^pr-\d+$/);
    }
  });
});
