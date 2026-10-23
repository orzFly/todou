import { describe, expect, it } from "vitest";
import {
  HUE_COUNT,
  MIN_TEXT_CONTRAST,
  projectTint,
  tintAt,
  whiteTextContrast,
} from "../src/lib/project-tint.ts";

describe("a project's fallback tint", () => {
  it("is the same colour for the same slug, release after release", () => {
    // Pinned: a project's colour is something its members learn to find it
    // by, so a change to the hash or the palette has to be a decision rather
    // than a side effect.
    expect(projectTint("todou")).toEqual({ from: "#b1549d", to: "#ac3a5c" });
    expect(projectTint("homelab")).toEqual({ from: "#c14f73", to: "#ae3f29" });
  });

  it("tells projects apart", () => {
    const tints = new Set(
      Array.from({ length: 200 }, (_, i) => projectTint(`project-${i}`).from),
    );
    expect(tints.size).toBeGreaterThan(100);
  });

  it("carries white text at AA contrast on every hue it can land on", () => {
    // Both ends are enough: the lightest point of an sRGB gradient is one of
    // its stops. Every theme draws the same colours, so this is every theme.
    for (let index = 0; index < HUE_COUNT; index++) {
      const { from, to } = tintAt(index);
      expect(whiteTextContrast(from)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(whiteTextContrast(to)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("measures contrast the way WCAG does", () => {
    expect(whiteTextContrast("#000000")).toBeCloseTo(21, 5);
    expect(whiteTextContrast("#ffffff")).toBeCloseTo(1, 5);
    // The published AA boundary grey.
    expect(whiteTextContrast("#767676")).toBeCloseTo(4.54, 2);
  });
});
