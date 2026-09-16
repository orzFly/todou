import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { THEMES } from "../src/lib/theme.ts";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const STYLES = read("../src/styles.css");
const CARD = read("../src/components/timeline/questions-card.tsx");
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
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(
    spec.trim(),
  );
  if (!m) throw new Error(`not a plain oklch() colour: ${spec}`);
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

function tokensOf(selector: string): Record<string, string> | null {
  const head = `${selector} {`;
  const start = STYLES.indexOf(head);
  if (start < 0) return null;
  const body = STYLES.slice(start + head.length, STYLES.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    out[m[1]] = m[2].trim();
  return out;
}

const themeBlock = (value: string) => tokensOf(`:root[data-theme="${value}"]`);

function tokensFor(value: string, kind: string): Record<string, string> {
  return {
    ...tokensOf(":root"),
    ...(kind === "dark" ? tokensOf(".dark") : {}),
    ...(themeBlock(value) ?? {}),
  };
}

const AMBER = oklch(
  (/--color-amber-500:\s*([^;]+);/.exec(TAILWIND) as RegExpExecArray)[1].trim(),
);

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
  const card = over(AMBER, oklch(tokens["--card"]), 0.05);
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

const measured = THEMES.map((theme) => ({
  theme,
  tokens: tokensFor(theme.value, theme.kind),
}));

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
    // them is mistyped this is the assertion that says so.
    const light = measured.find(
      (m) => m.theme.value === "light",
    ) as (typeof measured)[number];
    const card = over(AMBER, oklch(light.tokens["--card"]), 0.05);
    expect(hex(card)).toBe("#fffaf2");
  });

  it("measures both rows the card actually renders", () => {
    // Nothing else in this file fails if the templates stop being found — the
    // per-theme loops would simply iterate over an empty set and pass.
    expect(ROWS).toHaveLength(2);
  });

  it("draws an unselected row's hover edge clear of the row beside it", () => {
    const failures = [];
    for (const { theme, tokens } of measured) {
      for (const row of ROWS) {
        const { card, edge } = surfaces(tokens, classesOf(row.base, row.plain));
        if (edge === null) {
          failures.push({
            theme: `${theme.value} (no hover border)`,
            ratio: 0,
          });
          continue;
        }
        failures.push({ theme: theme.value, ratio: contrast(edge, card) });
      }
    }
    expect(worstFirst(failures.filter((f) => f.ratio < MIN_EDGE))).toEqual([]);
  });

  it("deepens a selected or declined row's own fill on hover", () => {
    const rows = [];
    for (const { theme, tokens } of measured) {
      for (const row of ROWS) {
        const { rest, hover } = surfaces(
          tokens,
          classesOf(row.base, row.marked),
        );
        rows.push({ theme: theme.value, ratio: contrast(hover, rest) });
      }
    }
    expect(worstFirst(rows.filter((r) => r.ratio < MIN_STATE_FILL))).toEqual(
      [],
    );
  });

  it("has a token block for every theme, so a new one cannot go unmeasured", () => {
    const unmeasured = THEMES.filter(
      (t) =>
        themeBlock(t.value) === null &&
        t.value !== "light" &&
        t.value !== "dark",
    );
    expect(unmeasured.map((t) => t.value)).toEqual([]);
    // The two themes with no data-theme block of their own are the defaults,
    // and they are only measurable because these blocks carry the full palette.
    expect(tokensOf(":root")).toHaveProperty("--card");
    expect(tokensOf(".dark")).toHaveProperty("--card");
  });
});
