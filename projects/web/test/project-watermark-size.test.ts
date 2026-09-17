import { describe, expect, it } from "vitest";
import { watermarkFontSize } from "../src/components/shared/ref-watermark.tsx";

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
