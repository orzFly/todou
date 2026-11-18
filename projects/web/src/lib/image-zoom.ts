/**
 * Geometry for the attachment viewer's zoomable image (T-535). Everything is
 * in the canvas's own pixel space: `x`/`y` is where the image's top-left sits,
 * `z` is display pixels per natural pixel.
 */
export type Frame = {
  /** Canvas size. */
  width: number;
  height: number;
  /** Image's natural size. */
  naturalWidth: number;
  naturalHeight: number;
  /** Whether fit may enlarge an image smaller than the canvas (maximized). */
  upscale: boolean;
  /**
   * The canvas's width before the zoom widened the dialog (T-774). Fit is
   * measured against it, so fitting a widened canvas shrinks the dialog
   * back instead of settling on a wider fit that holds it open.
   */
  restWidth?: number;
};

/** The width fit is measured against: the canvas at rest. */
function fitWidth(f: Frame): number {
  return Math.min(f.width, f.restWidth ?? f.width);
}

export type View = { z: number; x: number; y: number };

/** Deepest zoom, in natural pixels: far enough to read a single pixel. */
export const MAX_NATURAL_SCALE = 8;

export function fitScale(f: Frame): number {
  const contain = Math.min(
    fitWidth(f) / f.naturalWidth,
    f.height / f.naturalHeight,
  );
  return f.upscale ? contain : Math.min(1, contain);
}

/**
 * An upscaled fit can already sit past the natural-pixel cap (a 48px icon
 * maximized), so the ceiling always leaves room to double whatever fit is.
 */
export function maxScale(f: Frame): number {
  return Math.max(MAX_NATURAL_SCALE, fitScale(f) * 2);
}

/**
 * Never smaller than fit, except that actual pixels stay reachable when an
 * upscaled fit (maximized) is already larger than them.
 */
export function minScale(f: Frame): number {
  return Math.min(fitScale(f), 1);
}

export function fitView(f: Frame): View {
  const z = fitScale(f);
  return {
    z,
    x: (f.width - f.naturalWidth * z) / 2,
    y: (f.height - f.naturalHeight * z) / 2,
  };
}

/** Within a hair of fit counts as fit, so float drift cannot strand a view. */
export function isFitted(f: Frame, v: View): boolean {
  return Math.abs(v.z / fitScale(f) - 1) < 0.001;
}

export function isAtMin(f: Frame, v: View): boolean {
  return v.z <= minScale(f) * 1.001;
}

export function isAtMax(f: Frame, v: View): boolean {
  return v.z >= maxScale(f) * 0.999;
}

function clampAxis(pos: number, size: number, room: number): number {
  // A side smaller than the canvas centres; a larger one may not pull an
  // edge inside the canvas, so nothing past the image is ever exposed.
  if (size <= room) return (room - size) / 2;
  return Math.min(0, Math.max(room - size, pos));
}

export function clampView(f: Frame, v: View): View {
  const z = Math.min(Math.max(v.z, minScale(f)), maxScale(f));
  return {
    z,
    x: clampAxis(v.x, f.naturalWidth * z, f.width),
    y: clampAxis(v.y, f.naturalHeight * z, f.height),
  };
}

/**
 * The height a restored (not maximized) canvas asks for at zoom `z`: the
 * image's own, so zooming in grows the dialog until its CSS cap takes over
 * and only then starts panning (T-548). Never shorter than at fit, so the
 * request does not depend on the measured height it produces. Whole pixels,
 * because the canvas is measured back with clientHeight.
 */
export function canvasHeight(f: Frame, z: number): number {
  const restingScale = Math.min(1, fitWidth(f) / f.naturalWidth);
  return Math.round(f.naturalHeight * Math.max(z, restingScale));
}

/**
 * The width a restored canvas asks for at zoom `z`, the same way: the
 * image's own, never narrower than the canvas at rest (T-774). Whole pixels
 * past rest, because the canvas is measured back with clientWidth.
 */
export function canvasWidth(f: Frame, z: number): number {
  return Math.max(Math.round(f.naturalWidth * z), f.restWidth ?? f.width);
}

/**
 * Carry a view across a canvas resize. A fitted view refits; any other keeps
 * whatever sat at the canvas centre there — the dialog is centred, so that
 * is also what keeps the image still on screen while the canvas grows.
 */
export function reframe(prev: Frame, next: Frame, v: View): View {
  if (isFitted(prev, v)) return fitView(next);
  return clampView(next, {
    z: v.z,
    x: v.x + (next.width - prev.width) / 2,
    y: v.y + (next.height - prev.height) / 2,
  });
}

/** Scale by `factor` keeping canvas point (px, py) over the same image pixel. */
export function zoomAt(
  f: Frame,
  v: View,
  factor: number,
  px: number,
  py: number,
): View {
  const z = Math.min(maxScale(f), Math.max(minScale(f), v.z * factor));
  const k = z / v.z;
  return clampView(f, { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
}

/** Actual pixels (100%), keeping canvas point (px, py) over the same image pixel. */
export function actualAt(f: Frame, v: View, px: number, py: number): View {
  return zoomAt(f, v, 1 / v.z, px, py);
}

export function panBy(f: Frame, v: View, dx: number, dy: number): View {
  return clampView(f, { z: v.z, x: v.x + dx, y: v.y + dy });
}

/**
 * Click / tap: from fit, zoom at the pointer to actual pixels or twice the
 * fit, whichever is deeper — a fit of 0.8 jumping to 1.0 would look like
 * nothing happened. From anything else, back to fit.
 */
export function toggleAt(f: Frame, v: View, px: number, py: number): View {
  if (!isFitted(f, v)) return fitView(f);
  const target = Math.max(1, fitScale(f) * 2);
  return zoomAt(f, v, target / v.z, px, py);
}

/** Wheel delta → multiplicative factor. Pinch arrives as ctrl+wheel with small deltas. */
export function wheelFactor(
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
): number {
  const px =
    deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * (ctrlKey ? 0.01 : 0.002));
}

/** A rectangle of the canvas that one picture is drawn in, in canvas pixels. */
export type Pane = { x: number; y: number; width: number; height: number };

/**
 * Side by side's two panes in a canvas (T-733): left and right, or one above
 * the other, whichever draws the pictures larger at fit — a wide screenshot
 * stacks, a tall one sits beside its twin. A tie keeps them side by side, the
 * arrangement the inline comparison uses. The panes are as tall as `cap`
 * allows; the canvas then asks for its own height from them.
 */
export function sideBySidePanes(
  canvasWidth: number,
  cap: number,
  natural: { width: number; height: number },
  upscale: boolean,
  gap = 8,
): { direction: "row" | "column"; panes: [Pane, Pane] } {
  const scaleAt = (width: number, height: number) =>
    fitScale({
      width,
      height,
      naturalWidth: natural.width,
      naturalHeight: natural.height,
      upscale,
    });
  const rowWidth = (canvasWidth - gap) / 2;
  const columnHeight = (cap - gap) / 2;
  if (scaleAt(rowWidth, cap) >= scaleAt(canvasWidth, columnHeight)) {
    return {
      direction: "row",
      panes: [
        { x: 0, y: 0, width: rowWidth, height: cap },
        { x: rowWidth + gap, y: 0, width: rowWidth, height: cap },
      ],
    };
  }
  return {
    direction: "column",
    panes: [
      { x: 0, y: 0, width: canvasWidth, height: columnHeight },
      { x: 0, y: columnHeight + gap, width: canvasWidth, height: columnHeight },
    ],
  };
}

/**
 * How far a zoom stop holds against continuous input (T-780), in log scale:
 * about one notch of a mouse wheel.
 */
export const DETENT = Math.log(1.2);

/** Stops closer than this ratio are one stop; fit itself needs none. */
const STOP_MARGIN = 1.03;

/**
 * Where a zoom pauses on its way in (T-780): the whole picture as large as
 * the canvas can grow (contain), the canvas filled (cover), and actual
 * pixels, against `largest`, the biggest the canvas's first pane can get in
 * this window. None when that could not be measured.
 */
export function zoomStops(
  f: Frame,
  largest: { width: number; height: number },
): number[] {
  const { width, height } = largest;
  if (!(Number.isFinite(width) && width > 0)) return [];
  if (!(Number.isFinite(height) && height > 0)) return [];
  let contain = Math.min(width / f.naturalWidth, height / f.naturalHeight);
  // Contain has to fit with nothing to drag, even after rounding the canvas
  // to whole pixels.
  for (
    let i = 0;
    i < 8 &&
    (Math.round(f.naturalWidth * contain) > width ||
      Math.round(f.naturalHeight * contain) > height ||
      f.naturalWidth * contain > width ||
      f.naturalHeight * contain > height);
    i++
  )
    contain *= 1 - 1e-9;
  const cover = Math.max(width / f.naturalWidth, height / f.naturalHeight);
  const floor = fitScale(f) * STOP_MARGIN;
  const ceiling = maxScale(f);
  const stops: number[] = [];
  for (const z of [contain, cover, 1]
    .filter((z) => z > floor && z < ceiling)
    .sort((a, b) => a - b)) {
    const last = stops.at(-1);
    if (last === undefined || z / last >= STOP_MARGIN) stops.push(z);
    // Actual pixels is the stop worth landing on exactly.
    else if (z === 1) stops[stops.length - 1] = 1;
  }
  return stops;
}

/**
 * Continuous zoom input moves a raw position `u` in log scale; each stop
 * holds the zoom for DETENT of it and otherwise the zoom follows one to one,
 * so leaving a stop never jumps and backing out retraces the way in.
 */
export function detentZ(u: number, stops: number[]): number {
  let held = 0;
  stops.forEach((s, i) => {
    const start = Math.log(s) + i * DETENT;
    held += Math.min(Math.max(u - start, 0), DETENT);
  });
  return Math.exp(u - held);
}

/** The raw position that shows `z`; on a stop, the middle of its hold. */
export function detentU(z: number, stops: number[]): number {
  const l = Math.log(z);
  let below = 0;
  for (const [i, s] of stops.entries()) {
    const ls = Math.log(s);
    if (Math.abs(l - ls) < 1e-6) return ls + i * DETENT + DETENT / 2;
    if (ls < l) below++;
  }
  return l + below * DETENT;
}

/** Continuous input's state: the raw position, the zoom it gave, the stops it was read against. */
export type Detent = { u: number; z: number; stops: number[] };

/**
 * One step of continuous input. The raw position is read back from `z`
 * whenever something else set the zoom or the stops have moved since, so
 * travel never carries over from a hold that is no longer there.
 */
export function travel(
  prev: Detent | null,
  f: Frame,
  z: number,
  stops: number[],
  du: number,
): Detent {
  const fresh =
    prev === null ||
    Math.abs(prev.z - z) > 1e-9 * z ||
    prev.stops.length !== stops.length ||
    prev.stops.some((s, i) => s !== stops[i]);
  const from = fresh ? detentU(z, stops) : prev.u;
  // Clamped, so pushing past either end stores nothing to unwind.
  const u = Math.min(
    detentU(maxScale(f), stops),
    Math.max(detentU(minScale(f), stops), from + du),
  );
  return { u, z: detentZ(u, stops), stops };
}

/**
 * − / + : scale by `factor` about (px, py), stopping on the first stop it
 * would cross.
 */
export function stepAt(
  f: Frame,
  v: View,
  factor: number,
  stops: number[],
  px: number,
  py: number,
): View {
  let target = v.z * factor;
  if (factor > 1) {
    const crossed = stops.find((s) => s > v.z * 1.001 && s <= target);
    if (crossed !== undefined) target = crossed;
  } else {
    const crossed = stops.findLast((s) => s < v.z / 1.001 && s >= target);
    if (crossed !== undefined) target = crossed;
  }
  return zoomAt(f, v, target / v.z, px, py);
}
