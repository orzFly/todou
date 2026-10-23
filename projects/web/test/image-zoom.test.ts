import { describe, expect, it } from "vitest";
import {
  actualAt,
  canvasHeight,
  clampView,
  type Frame,
  fitScale,
  fitView,
  isAtMax,
  isAtMin,
  isFitted,
  MAX_NATURAL_SCALE,
  maxScale,
  panBy,
  reframe,
  toggleAt,
  type View,
  wheelFactor,
  zoomAt,
} from "@/lib/image-zoom.ts";

const big: Frame = {
  width: 1000,
  height: 750,
  naturalWidth: 1800,
  naturalHeight: 2600,
  upscale: false,
};
const icon: Frame = {
  width: 1000,
  height: 750,
  naturalWidth: 48,
  naturalHeight: 48,
  upscale: false,
};

const pixelAt = (v: View, px: number, py: number) => ({
  x: (px - v.x) / v.z,
  y: (py - v.y) / v.z,
});

describe("fit", () => {
  it("contains a large image and centres it", () => {
    const v = fitView(big);
    expect(v.z).toBeCloseTo(750 / 2600);
    expect(v.y).toBeCloseTo(0);
    expect(v.x).toBeCloseTo((1000 - 1800 * v.z) / 2);
  });

  it("never enlarges a small image unless upscale is on", () => {
    expect(fitScale(icon)).toBe(1);
    expect(fitScale({ ...icon, upscale: true })).toBeCloseTo(750 / 48);
  });

  it("leaves room to zoom past an upscaled fit", () => {
    const up = { ...icon, upscale: true };
    expect(maxScale(up)).toBeCloseTo(fitScale(up) * 2);
    expect(maxScale(big)).toBe(MAX_NATURAL_SCALE);
  });
});

describe("zoomAt", () => {
  it("keeps the image pixel under the pointer", () => {
    const v0 = fitView(big);
    const v1 = zoomAt(big, v0, 3, 500, 300);
    expect(v1.z).toBeCloseTo(v0.z * 3);
    const a = pixelAt(v0, 500, 300);
    const b = pixelAt(v1, 500, 300);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.y).toBeCloseTo(a.y);
  });

  it("stops at fit and at the ceiling", () => {
    const v0 = fitView(big);
    expect(zoomAt(big, v0, 0.1, 500, 300).z).toBeCloseTo(v0.z);
    const top = zoomAt(big, v0, 1e6, 500, 300);
    expect(top.z).toBe(MAX_NATURAL_SCALE);
    expect(isAtMax(big, top)).toBe(true);
  });
});

describe("actualAt (T-537)", () => {
  it("lands on exactly 100% about the given point", () => {
    const v0 = zoomAt(big, fitView(big), 2.3, 400, 200);
    const v1 = actualAt(big, v0, 400, 200);
    expect(v1.z).toBe(1);
    const a = pixelAt(v0, 400, 200);
    const b = pixelAt(v1, 400, 200);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.y).toBeCloseTo(a.y);
  });

  it("reaches 100% below an upscaled fit, which then counts as the floor", () => {
    const up = { ...icon, upscale: true };
    const fit = fitView(up);
    expect(fit.z).toBeGreaterThan(1);
    const one = actualAt(up, fit, 500, 375);
    expect(one.z).toBe(1);
    expect(isFitted(up, one)).toBe(false);
    expect(isAtMin(up, one)).toBe(true);
    expect(isAtMin(up, fit)).toBe(false);
    // A click from below fit goes back to fit, not further in.
    expect(toggleAt(up, one, 500, 375)).toEqual(fit);
  });

  it("leaves a not-upscaled fit as the floor", () => {
    expect(isAtMin(big, fitView(big))).toBe(true);
    expect(zoomAt(big, fitView(big), 0.1, 0, 0).z).toBeCloseTo(fitScale(big));
  });
});

describe("clamp", () => {
  it("never exposes canvas past the image edges", () => {
    const v = zoomAt(big, fitView(big), 4, 500, 375);
    const tl = panBy(big, v, 1e5, 1e5);
    expect(tl.x).toBe(0);
    expect(tl.y).toBe(0);
    const br = panBy(big, v, -1e5, -1e5);
    expect(br.x).toBeCloseTo(1000 - 1800 * v.z);
    expect(br.y).toBeCloseTo(750 - 2600 * v.z);
  });

  it("centres an axis that is narrower than the canvas", () => {
    const v = clampView(big, { z: 0.4, x: -300, y: 0 });
    // 1800 × 0.4 = 720 < 1000 wide, 2600 × 0.4 = 1040 > 750 tall.
    expect(v.x).toBeCloseTo(140);
    expect(v.y).toBe(0);
  });
});

describe("toggleAt", () => {
  it("goes fit → actual pixels → fit", () => {
    const fit = fitView(big);
    const one = toggleAt(big, fit, 500, 300);
    expect(one.z).toBe(1);
    expect(isFitted(big, one)).toBe(false);
    expect(toggleAt(big, one, 10, 10)).toEqual(fit);
  });

  it("doubles a fit that is already at or near actual pixels", () => {
    expect(toggleAt(icon, fitView(icon), 500, 375).z).toBe(2);
    const near: Frame = { ...big, naturalWidth: 1100, naturalHeight: 800 };
    expect(toggleAt(near, fitView(near), 500, 375).z).toBeCloseTo(
      fitScale(near) * 2,
    );
  });
});

describe("wheelFactor", () => {
  it("zooms in on wheel-up and out on wheel-down, symmetrically", () => {
    const up = wheelFactor(-100, 0, false);
    expect(up).toBeGreaterThan(1);
    expect(up * wheelFactor(100, 0, false)).toBeCloseTo(1);
  });

  it("treats a line as 16px and a pinch delta as finer-grained", () => {
    expect(wheelFactor(-3, 1, false)).toBeCloseTo(wheelFactor(-48, 0, false));
    expect(wheelFactor(-10, 0, true)).toBeCloseTo(wheelFactor(-50, 0, false));
  });
});

const wide: Frame = {
  width: 1000,
  height: 250,
  naturalWidth: 2000,
  naturalHeight: 500,
  upscale: false,
};

describe("canvasHeight", () => {
  it("asks for the image's height at fit, then grows with the zoom", () => {
    expect(canvasHeight(wide, fitScale(wide))).toBe(250);
    expect(canvasHeight(wide, 1)).toBe(500);
    expect(canvasHeight(wide, 3)).toBe(1500);
  });

  it("never asks for less than the width-fit height", () => {
    expect(canvasHeight(wide, 0.1)).toBe(250);
    expect(canvasHeight(icon, 1)).toBe(48);
  });
});

describe("reframe", () => {
  const grown = { ...wide, height: 750 };

  it("refits a fitted view", () => {
    expect(reframe(wide, grown, fitView(wide))).toEqual(fitView(grown));
  });

  it("moves the image down by half the growth, holding it still on screen", () => {
    const v = clampView(wide, { z: 2, x: -500, y: -500 });
    expect(reframe(wide, grown, v)).toEqual({ z: 2, x: -500, y: -250 });
  });
});
