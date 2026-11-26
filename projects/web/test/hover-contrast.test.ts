import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  builtinThemes,
  resolvePalette,
  schemesOf,
  themesForStyle,
  variantsOf,
} from "@orz/themes";
import { describe, expect, it } from "vitest";

// Not `import.meta.url`: under this setup that is not a `file:` URL.
const CARD = readFileSync(
  resolve(process.cwd(), "src/components/timeline/questions-card.tsx"),
  "utf8",
);
// Resolved, not transcribed: a pasted amber would keep reporting the contrast
// of whatever Tailwind's palette held on the day somebody copied it, and the
// whole point of these numbers is that they track the real dependency.
const TAILWIND = readFileSync(
  createRequire(import.meta.url).resolve("tailwindcss/theme.css"),
  "utf8",
);

type Rgb = [number, number, number];

/** CSS Color 4's Oklab matrices, then the sRGB transfer function. */
function oklch(spec: string): Rgb {
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(spec.trim());
  if (hexMatch) {
    const digits =
      hexMatch[1].length === 3
        ? [...hexMatch[1]].map((d) => d + d).join("")
        : hexMatch[1];
    return [0, 2, 4].map((i) =>
      Number.parseInt(digits.slice(i, i + 2), 16),
    ) as Rgb;
  }
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(
    spec.trim(),
  );
  if (!m) throw new Error(`not a hex or plain oklch() colour: ${spec}`);
  const lightness = m[2] === "%" ? Number(m[1]) / 100 : Number(m[1]);
  const chroma = Number(m[3]);
  const hue = (Number(m[4]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (v: number) => {
    const e = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(e * 255)));
  };
  return [
    encode(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    encode(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    encode(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  ];
}

const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb => [
  Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
  Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
  Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
];

const hex = (c: Rgb) =>
  `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** WCAG 2.x relative luminance and the (L1+0.05)/(L2+0.05) ratio. */
function contrast(x: Rgb, y: Rgb): number {
  const luminance = (c: Rgb) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Every palette a user can pick under the default style: each theme's light
// and dark side, in each variant that side defines. Read from @orz/themes
// itself, so a theme or variant added upstream is measured the day it lands.
const THEMES = themesForStyle(builtinThemes, "default");
const measured = THEMES.flatMap((theme) =>
  schemesOf(theme).flatMap((scheme) =>
    variantsOf(theme).flatMap(({ id }) => {
      const palette = resolvePalette(theme, scheme, id);
      if (palette === null || palette.variant !== id) return [];
      const tokens: Record<string, string> = {};
      for (const [name, value] of Object.entries(palette.tokens))
        tokens[`--${name}`] = value;
      const label = `${theme.id}/${scheme}${id === "default" ? "" : `/${id}`}`;
      return [{ label, tokens }];
    }),
  ),
);

// The amber the card was tinted with when the customer took the screenshot.
const AMBER = oklch(
  (/--color-amber-500:\s*([^;]+);/.exec(TAILWIND) as RegExpExecArray)[1].trim(),
);

// The unanswered card's own face, read off its class rather than restated:
// a token tinted onto the card at some opacity.
const FACE = (() => {
  const m = /"@container mt-1 [^"]*\bbg-([a-z-]+)\/(\d+)\b/.exec(CARD);
  if (!m) throw new Error("the unanswered card's face is not a token tint");
  return { token: `--${m[1]}`, alpha: Number(m[2]) / 100 };
})();

type Paint = { token: string; alpha: number } | null;

/**
 * The last `bg-`/`border-` utility that applies in the given state wins, which
 * is why these are walked in order rather than searched for. Only the palette
 * spellings this card uses are understood: an unrecognised one throws instead
 * of scoring as transparent, because a colour that silently measures as
 * "nothing painted" is indistinguishable from the bug being guarded here.
 */
function paint(classes: string[], property: string, hovered: boolean): Paint {
  const TOKENS: Record<string, string> = {
    foreground: "--foreground",
    primary: "--primary",
    destructive: "--destructive",
    muted: "--muted",
    card: "--card",
    accent: "--accent",
    secondary: "--secondary",
  };
  let found: Paint = null;
  for (const raw of classes) {
    const parts = raw.split(":");
    const utility = parts.pop() as string;
    if (parts.includes("hover") !== hovered) continue;
    if (!utility.startsWith(`${property}-`)) continue;
    const [name, alpha] = utility.slice(property.length + 1).split("/");
    if (name === "transparent") {
      found = null;
      continue;
    }
    const token = TOKENS[name];
    if (token === undefined) throw new Error(`unmapped colour utility: ${raw}`);
    found = { token, alpha: alpha === undefined ? 1 : Number(alpha) / 100 };
  }
  return found;
}

const ROW_TEMPLATE =
  /className=\{`([^`]*?)\$\{[\s\S]*?\?\s*"([^"]*)"\s*:\s*"([^"]*)"/g;
const ROWS = [...CARD.matchAll(ROW_TEMPLATE)]
  .filter((m) => m[1].includes("rounded-md border"))
  .map((m) => ({ base: m[1], marked: m[2], plain: m[3] }));

const classesOf = (base: string, branch: string) =>
  `${base} ${branch}`.trim().split(/\s+/);

function surfaces(tokens: Record<string, string>, classes: string[]) {
  const card = over(
    oklch(tokens[FACE.token]),
    oklch(tokens["--card"]),
    FACE.alpha,
  );
  const fill = (p: Paint) =>
    p === null ? card : over(oklch(tokens[p.token]), card, p.alpha);
  const hoverFill = paint(classes, "bg", true);
  return {
    card,
    rest: fill(paint(classes, "bg", false)),
    // A hover background replaces the resting one rather than stacking on it;
    // where the row declares none, hovering leaves the resting fill standing.
    hover:
      hoverFill === null ? fill(paint(classes, "bg", false)) : fill(hoverFill),
    // Composited over the card rather than over the row's own hover fill: the
    // real border paints on top of that fill, which pushes it further from the
    // neighbouring resting row, so measuring against the card under-reports.
    edge: (() => {
      const p = paint(classes, "border", true);
      return p === null ? null : fill(p);
    })(),
  };
}

// The minima design.md measured, less a hair of rounding headroom. Raising a
// threshold above its measured value is how this test is meant to be proven
// capable of failing.
const MIN_EDGE = 1.9;
const MIN_STATE_FILL = 1.05;

const worstFirst = (rows: { theme: string; ratio: number }[]) =>
  rows
    .sort((a, b) => a.ratio - b.ratio)
    .map((r) => `${r.theme} ${r.ratio.toFixed(2)}:1`);

describe("question row hover contrast", () => {
  it("reproduces the card face the customer screenshotted", () => {
    // Three independent sources agree on this pixel (design.md): the model
    // below, Chrome's own engine in the mockup, and the reported screenshot.
    // Every other number here rides on the same two formulas, so when one of
    // them is mistyped this is the assertion that says so. The card the
    // screenshot was taken on is the light --card todou had before @orz/ui.
    const card = over(AMBER, oklch("oklch(1 0 0)"), 0.05);
    expect(hex(card)).toBe("#fffaf2");
  });

  it("measures both rows the card actually renders", () => {
    // Nothing else in this file fails if the templates stop being found — the
    // per-theme loops would simply iterate over an empty set and pass.
    expect(ROWS).toHaveLength(2);
  });

  it("draws an unselected row's hover edge clear of the row beside it", () => {
    const failures = [];
    for (const { label, tokens } of measured) {
      for (const row of ROWS) {
        const { card, edge } = surfaces(tokens, classesOf(row.base, row.plain));
        if (edge === null) {
          failures.push({ theme: `${label} (no hover border)`, ratio: 0 });
          continue;
        }
        failures.push({ theme: label, ratio: contrast(edge, card) });
      }
    }
    expect(worstFirst(failures.filter((f) => f.ratio < MIN_EDGE))).toEqual([]);
  });

  it("deepens a selected or declined row's own fill on hover", () => {
    const rows = [];
    for (const { label, tokens } of measured) {
      for (const row of ROWS) {
        const { rest, hover } = surfaces(
          tokens,
          classesOf(row.base, row.marked),
        );
        rows.push({ theme: label, ratio: contrast(hover, rest) });
      }
    }
    expect(worstFirst(rows.filter((r) => r.ratio < MIN_STATE_FILL))).toEqual(
      [],
    );
  });

  it("measures every theme a todou-theme preference can map to", () => {
    // The themes the old todou-theme values land on (design.md, theme
    // table). Each must be offered by the default style and measured above,
    // light and dark where it has both.
    const legacy = [
      "default",
      "picotera",
      "solarized",
      "vs",
      "github",
      "catppuccin",
      "gruvbox",
      "dracula",
      "nord",
      "tokyo-night",
      "one-dark",
      "monokai",
    ];
    const ids = new Set(measured.map((m) => m.label.split("/")[0]));
    expect(legacy.filter((id) => !ids.has(id))).toEqual([]);
    expect(measured.map((m) => m.label)).toEqual(
      expect.arrayContaining(["default/light", "default/dark"]),
    );
  });
});
