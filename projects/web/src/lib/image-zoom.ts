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
};

export type View = { z: number; x: number; y: number };

/** Deepest zoom, in natural pixels: far enough to read a single pixel. */
export const MAX_NATURAL_SCALE = 8;

export function fitScale(f: Frame): number {
  const contain = Math.min(
    f.width / f.naturalWidth,
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
  return v.z <= fitScale(f) * 1.001;
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
  const z = Math.min(Math.max(v.z, fitScale(f)), maxScale(f));
  return {
    z,
    x: clampAxis(v.x, f.naturalWidth * z, f.width),
    y: clampAxis(v.y, f.naturalHeight * z, f.height),
  };
}

/** Scale by `factor` keeping canvas point (px, py) over the same image pixel. */
export function zoomAt(
  f: Frame,
  v: View,
  factor: number,
  px: number,
  py: number,
): View {
  const z = Math.min(maxScale(f), Math.max(fitScale(f), v.z * factor));
  const k = z / v.z;
  return clampView(f, { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
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
