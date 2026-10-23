/**
 * The gradient a project without an uploaded icon is drawn on (T-544): a hue
 * hashed from the slug, so the same project wears the same colour on every
 * surface and in every theme.
 *
 * The slug rather than the id because several surfaces hold nothing else — a
 * muted project, a grant-access candidate, the shell while the project loads.
 * Renaming the slug therefore recolours the icon, which was accepted on T-544.
 */

type Rgb = readonly [number, number, number];

/** White text has to reach this against both ends of the gradient (WCAG AA). */
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * Yellow-greens are left out: darkened far enough to carry white text they
 * come out olive and mustard, which read as dirty rather than as a colour.
 */
const SKIPPED_FROM = 60;
const SKIPPED_TO = 130;
export const HUE_COUNT = 360 - (SKIPPED_TO - SKIPPED_FROM);

const LIGHTNESS = 0.62;
const DARKER_BY = 0.1;
const CHROMA = 0.15;
const HUE_SHIFT = 30;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function oklchToLinearSrgb(l: number, c: number, hue: number): Rgb {
  const radians = (hue * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ] as const;
  return [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

const encode = (v: number) => {
  const clamped = Math.min(1, Math.max(0, v));
  return Math.round(
    255 *
      (clamped <= 0.0031308
        ? 12.92 * clamped
        : 1.055 * clamped ** (1 / 2.4) - 0.055),
  );
};

const decode = (channel: number) => {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function toSrgb(l: number, c: number, hue: number): Rgb {
  let chroma = c;
  if (!inGamut(oklchToLinearSrgb(l, chroma, hue))) {
    let low = 0;
    let high = chroma;
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinearSrgb(l, mid, hue))) low = mid;
      else high = mid;
    }
    chroma = low;
  }
  const [r, g, b] = oklchToLinearSrgb(l, chroma, hue);
  return [encode(r), encode(g), encode(b)];
}

const relativeLuminance = ([r, g, b]: Rgb) =>
  0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);

/** WCAG contrast of white text on an sRGB `#rrggbb` colour. */
export function whiteTextContrast(hex: string): number {
  const rgb = [1, 3, 5].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  ) as unknown as Rgb;
  return 1.05 / (relativeLuminance(rgb) + 0.05);
}

const toHex = (rgb: Rgb) =>
  `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * Darkened until white text clears the bar, measured on the 8-bit value that
 * is actually drawn. Checking both ends is enough: between two sRGB stops the
 * browser interpolates gamma-encoded channels, along which luminance is
 * convex, so the lightest point of the gradient is always one of its ends.
 */
function legibleStop(lightness: number, hue: number): string {
  let l = lightness;
  let rgb = toSrgb(l, CHROMA, hue);
  while (1.05 / (relativeLuminance(rgb) + 0.05) < MIN_TEXT_CONTRAST) {
    l -= 0.005;
    rgb = toSrgb(l, CHROMA, hue);
  }
  return toHex(rgb);
}

export interface ProjectTint {
  /** Top-left stop. */
  from: string;
  /** Bottom-right stop: darker, and the hue turned a little. */
  to: string;
}

/** The tint for the `index`th usable hue, `0 <= index < HUE_COUNT`. */
export function tintAt(index: number): ProjectTint {
  const hue = (SKIPPED_TO + index) % 360;
  const ahead = (hue + HUE_SHIFT) % 360;
  // Turning towards the skipped band would land the dark end in it.
  const turned =
    ahead > SKIPPED_FROM && ahead < SKIPPED_TO
      ? (hue - HUE_SHIFT + 360) % 360
      : ahead;
  return {
    from: legibleStop(LIGHTNESS, hue),
    to: legibleStop(LIGHTNESS - DARKER_BY, turned),
  };
}

const cache = new Map<string, ProjectTint>();

export function projectTint(slug: string): ProjectTint {
  let tint = cache.get(slug);
  if (!tint) {
    tint = tintAt(fnv1a(slug) % HUE_COUNT);
    cache.set(slug, tint);
  }
  return tint;
}
