import { describe, expect, it } from "vitest";
import {
  actualAt,
  canvasHeight,
  canvasWidth,
  clampView,
  DETENT,
  detentU,
  detentZ,
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
  stepAt,
  toggleAt,
  travel,
  type View,
  wheelFactor,
  zoomAt,
  zoomStops,
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

describe("a canvas the zoom widened (T-774)", () => {
  const widened: Frame = { ...wide, width: 1600, restWidth: 1000 };

  it("asks for the image's width, never narrower than at rest", () => {
    expect(canvasWidth(wide, fitScale(wide))).toBe(1000);
    expect(canvasWidth(wide, 1)).toBe(2000);
    expect(canvasWidth(widened, 0.3)).toBe(1000);
  });

  it("fits as it would at rest, so fitting asks for the rest width back", () => {
    expect(fitScale(widened)).toBe(fitScale(wide));
    expect(canvasWidth(widened, fitScale(widened))).toBe(1000);
    expect(canvasHeight(widened, fitScale(widened))).toBe(250);
  });

  it("centres the rest fit in the wider canvas", () => {
    expect(fitView(widened)).toEqual({ z: 0.5, x: 300, y: 0 });
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

// A 1920×1080 screenshot in a 1280×800 window: the restored canvas rests at
// 992 wide, and the largest the dialog can grow it to is 1216×600.
const shot: Frame = {
  width: 992,
  height: 558,
  naturalWidth: 1920,
  naturalHeight: 1080,
  upscale: false,
  restWidth: 992,
};
const largest = { width: 1216, height: 600 };

/** Contain has to show the whole picture with nothing to drag. */
function expectContainFits(
  f: Frame,
  room: { width: number; height: number },
  z: number,
) {
  expect(canvasWidth(f, z)).toBeLessThanOrEqual(room.width);
  expect(canvasHeight(f, z)).toBeLessThanOrEqual(room.height);
  // Grown to the largest it can be, still fitting against its resting width.
  const grown: Frame = { ...f, ...room };
  const v = clampView(grown, { z, x: -1e6, y: -1e6 });
  expect(v.x).toBeCloseTo((room.width - f.naturalWidth * v.z) / 2, 9);
  expect(v.y).toBeCloseTo((room.height - f.naturalHeight * v.z) / 2, 9);
  expect(v.x).toBeGreaterThanOrEqual(0);
  expect(v.y).toBeGreaterThanOrEqual(0);
}

describe("zoomStops (T-780)", () => {
  it("stops at contain, cover and actual pixels past a restored fit", () => {
    const stops = zoomStops(shot, largest);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toBeCloseTo(600 / 1080, 6);
    expect(stops[1]).toBeCloseTo(1216 / 1920, 6);
    expect(stops[2]).toBe(1);
    expectContainFits(shot, largest, stops[0]);
  });

  it("drops contain when maximized, where it is fit", () => {
    const max: Frame = {
      width: 1248,
      height: 560,
      naturalWidth: 1920,
      naturalHeight: 1080,
      upscale: true,
      restWidth: 1248,
    };
    const stops = zoomStops(max, { width: 1248, height: 560 });
    expect(stops).toHaveLength(2);
    expect(stops[0]).toBeCloseTo(1248 / 1920, 6);
    expect(stops[1]).toBe(1);
  });

  it("merges a cover within 3% of actual pixels into actual pixels", () => {
    const room = { width: 1882, height: 900 };
    const stops = zoomStops(shot, room);
    expect(stops).toHaveLength(2);
    expect(stops[0]).toBeCloseTo(900 / 1080, 6);
    expect(stops[1]).toBe(1);
    expectContainFits(shot, room, stops[0]);
  });

  it("enlarges a small image to contain and cover", () => {
    const small: Frame = {
      width: 992,
      height: 300,
      naturalWidth: 420,
      naturalHeight: 300,
      upscale: false,
      restWidth: 992,
    };
    const stops = zoomStops(small, largest);
    expect(stops).toHaveLength(2);
    expect(stops[0]).toBeCloseTo(2, 6);
    expect(stops[1]).toBeCloseTo(1216 / 420, 6);
    expectContainFits(small, largest, stops[0]);
  });

  it("drops a stop at or past the deepest zoom", () => {
    const strip: Frame = {
      width: 992,
      height: 558,
      naturalWidth: 200,
      naturalHeight: 100,
      upscale: false,
      restWidth: 992,
    };
    const room = { width: 1800, height: 600 };
    const stops = zoomStops(strip, room);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBeCloseTo(6, 6);
    expectContainFits(strip, room, stops[0]);
  });

  it("brings contain back inside a canvas it would overflow by a hair", () => {
    // 1080 × (602 / 1080) is 602.0000000000001 in floating point.
    const room = { width: 1216, height: 602 };
    const [contain] = zoomStops(shot, room);
    expect(1080 * contain).toBeLessThanOrEqual(602);
    expectContainFits(shot, room, contain);
  });

  it("has none when the largest canvas could not be measured", () => {
    expect(zoomStops(shot, { width: Number.NaN, height: 600 })).toEqual([]);
    expect(zoomStops(shot, { width: 1216, height: 0 })).toEqual([]);
  });
});

describe("detent (T-780)", () => {
  const stops = [0.5556, 0.6333, 1];
  const starts = stops.map((s, i) => Math.log(s) + i * DETENT);

  it("follows the input without a jump, and never backs off", () => {
    let prev = Math.log(detentZ(Math.log(0.4), stops));
    for (let u = Math.log(0.4) + 0.001; u <= Math.log(2); u += 0.001) {
      const next = Math.log(detentZ(u, stops));
      expect(next).toBeGreaterThanOrEqual(prev);
      expect(next - prev).toBeLessThanOrEqual(0.001 + 1e-12);
      prev = next;
    }
  });

  it("holds each stop for DETENT of input", () => {
    starts.forEach((start, i) => {
      for (const k of [0, 0.25, 0.5, 0.75, 1])
        expect(detentZ(start + k * DETENT, stops)).toBeCloseTo(stops[i], 12);
    });
  });

  it("reads a zoom back to the position that shows it", () => {
    for (const z of [0.5, 0.6, 0.8, 1.5]) {
      expect(detentZ(detentU(z, stops), stops)).toBeCloseTo(z, 12);
    }
    stops.forEach((s, i) => {
      expect(detentU(s, stops)).toBeCloseTo(starts[i] + DETENT / 2, 12);
    });
  });

  it("enters a stop on one notch of a mouse wheel and leaves on the next", () => {
    const notch = Math.log(1.22);
    for (const s of stops) {
      const entered = travel(null, shot, s / 1.1, stops, notch);
      expect(entered.z).toBeCloseTo(s, 12);
      const left = travel(entered, shot, entered.z, stops, notch);
      expect(left.z).toBeCloseTo(
        s * Math.exp(2 * notch - Math.log(1.1) - DETENT),
        12,
      );
    }
  });

  it("backs out of a stop the way it came in", () => {
    const below = travel(null, shot, stops[1] / 1.1, stops, 0);
    const into = travel(
      below,
      shot,
      below.z,
      stops,
      starts[1] - below.u + 0.05,
    );
    expect(into.z).toBeCloseTo(stops[1], 12);
    const back = travel(into, shot, into.z, stops, -0.06);
    expect(back.z).toBeLessThan(stops[1]);
  });

  it("reads the position again when something else moved the zoom", () => {
    const held = travel(null, shot, 0.7, stops, 0.01);
    const clicked = travel(held, shot, 1.0333, stops, 0.01);
    expect(clicked.z).toBeCloseTo(1.0333 * Math.exp(0.01), 12);
    const moved = travel(held, shot, held.z, [0.6, 1], 0);
    expect(moved.u).toBeCloseTo(detentU(held.z, [0.6, 1]), 12);
    expect(moved.z).toBeCloseTo(held.z, 12);
  });

  it("stores nothing past either end", () => {
    const top = travel(null, shot, maxScale(shot), stops, 5);
    expect(top.z).toBeCloseTo(maxScale(shot), 9);
    expect(travel(top, shot, top.z, stops, -0.1).z).toBeLessThan(
      maxScale(shot),
    );
    const bottom = travel(null, shot, fitScale(shot), stops, -5);
    expect(bottom.z).toBeCloseTo(fitScale(shot), 9);
    expect(travel(bottom, shot, bottom.z, stops, 0.01).z).toBeGreaterThan(
      fitScale(shot),
    );
  });
});

describe("stepAt (T-780)", () => {
  const stops = [0.5556, 0.6333, 1];
  const press = (factor: number, from: View, n: number) => {
    const zs: number[] = [];
    let v = from;
    for (let i = 0; i < n; i++) {
      v = stepAt(shot, v, factor, stops, shot.width / 2, shot.height / 2);
      zs.push(v.z);
    }
    return zs;
  };

  it("stops on every stop it crosses on the way in", () => {
    const zs = press(1.25, fitView(shot), 6);
    const fit = 992 / 1920;
    [0.5556, 0.6333, 0.6333 * 1.25, 0.6333 * 1.25 ** 2, 1, 1.25].forEach(
      (z, i) => {
        expect(zs[i]).toBeCloseTo(z, 9);
      },
    );
    expect(fit).toBeCloseTo(fitScale(shot), 9);
  });

  it("stops on every stop it crosses on the way out", () => {
    const zs = press(1 / 1.25, clampView(shot, { z: 1, x: 0, y: 0 }), 5);
    [0.8, 0.64, 0.6333, 0.5556, 992 / 1920].forEach((z, i) => {
      expect(zs[i]).toBeCloseTo(z, 9);
    });
  });
});
