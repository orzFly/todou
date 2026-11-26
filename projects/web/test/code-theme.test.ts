import {
  builtinThemes,
  resolvePalette,
  schemesOf,
  type Theme,
  themesForStyle,
  variantsOf,
} from "@orz/themes";
import { ThemeProvider, type ThemeStore } from "@orz/ui/theme";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PIERRE_THEME,
  syntaxThemeFor,
  useSyntaxTheme,
} from "../src/components/shared/pierre.tsx";
import { createTodouThemeStore } from "../src/lib/theme-store.ts";

let store: ThemeStore | undefined;

afterEach(() => {
  store?.dispose();
  store = undefined;
  localStorage.clear();
});

function renderSyntax() {
  store = createTodouThemeStore();
  const own = store;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ThemeProvider, { store: own }, children);
  return { store: own, ...renderHook(() => useSyntaxTheme(), { wrapper }) };
}

const THEMES = themesForStyle(builtinThemes, "default");
const theme = (id: string) => THEMES.find((t) => t.id === id) as Theme;

/** Every palette of the default style that names a shiki theme. */
const NAMED = THEMES.flatMap((t) =>
  schemesOf(t).flatMap((scheme) =>
    variantsOf(t).flatMap(({ id }) => {
      const palette = resolvePalette(t, scheme, id);
      return palette !== null &&
        palette.variant === id &&
        typeof palette.syntax === "string"
        ? [{ label: `${t.id}/${scheme}/${id}`, scheme, syntax: palette.syntax }]
        : [];
    }),
  ),
);

// Copied verbatim from @pierre/theming's shiki collection rather than
// imported: a name absent from it throws UnregisteredThemeError at render
// time, and importing the real list would let an upstream rename silently
// take a theme's syntax with it.
const SHIKI_THEMES = new Set([
  "ayu-light",
  "catppuccin-latte",
  "everforest-light",
  "github-light",
  "github-light-default",
  "github-light-high-contrast",
  "gruvbox-light-hard",
  "gruvbox-light-medium",
  "gruvbox-light-soft",
  "horizon-bright",
  "kanagawa-lotus",
  "light-plus",
  "material-theme-lighter",
  "min-light",
  "night-owl-light",
  "one-light",
  "rose-pine-dawn",
  "slack-ochin",
  "snazzy-light",
  "solarized-light",
  "vitesse-light",
  "andromeeda",
  "aurora-x",
  "ayu-dark",
  "ayu-mirage",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "dark-plus",
  "dracula",
  "dracula-soft",
  "everforest-dark",
  "github-dark",
  "github-dark-default",
  "github-dark-dimmed",
  "github-dark-high-contrast",
  "gruvbox-dark-hard",
  "gruvbox-dark-medium",
  "gruvbox-dark-soft",
  "horizon",
  "houston",
  "kanagawa-dragon",
  "kanagawa-wave",
  "laserwave",
  "material-theme",
  "material-theme-darker",
  "material-theme-ocean",
  "material-theme-palenight",
  "min-dark",
  "monokai",
  "night-owl",
  "nord",
  "one-dark-pro",
  "plastic",
  "poimandres",
  "red",
  "rose-pine",
  "rose-pine-moon",
  "slack-dark",
  "solarized-dark",
  "synthwave-84",
  "tokyo-night",
  "vesper",
  "vitesse-black",
  "vitesse-dark",
]);
describe("syntaxThemeFor", () => {
  it("fills each slot from its own side under system", () => {
    expect(syntaxThemeFor(theme("solarized"), "light", "system")).toEqual({
      light: "solarized-light",
      dark: "solarized-dark",
    });
    // The side in view does not matter: CSS picks between the two slots.
    expect(syntaxThemeFor(theme("solarized"), "dark", "system")).toBe(
      syntaxThemeFor(theme("solarized"), "light", "system"),
    );
  });

  it("fills both slots from the side in view when the mode is fixed", () => {
    expect(syntaxThemeFor(theme("solarized"), "light", "light")).toEqual({
      light: "solarized-light",
      dark: "solarized-light",
    });
    expect(syntaxThemeFor(theme("vs"), "dark", "dark")).toEqual({
      light: "dark-plus",
      dark: "dark-plus",
    });
  });

  it("fills a one-sided theme's slots from that side even under system", () => {
    expect(syntaxThemeFor(theme("dracula"), "dark", "system")).toEqual({
      light: "dracula",
      dark: "dracula",
    });
  });

  it("reads the variant asked for", () => {
    expect(
      syntaxThemeFor(theme("catppuccin"), "dark", "dark", "frappe"),
    ).toEqual({ light: "catppuccin-frappe", dark: "catppuccin-frappe" });
  });

  it("keeps pierre's own theme for a palette with no shiki name", () => {
    // default names no syntax theme; pro-graphite draws a TextMate theme of
    // its own, which pierre does not know by name.
    expect(syntaxThemeFor(theme("default"), "light", "system")).toBe(
      PIERRE_THEME,
    );
    const drawn = THEMES.find(
      (t) => typeof resolvePalette(t, "light")?.syntax === "object",
    ) as Theme;
    expect(drawn).toBeDefined();
    expect(syntaxThemeFor(drawn, "light", "light")).toBe(PIERRE_THEME);
  });

  it("hands out one object per pair of names", () => {
    const first = syntaxThemeFor(theme("nord"), "dark", "dark");
    expect(syntaxThemeFor(theme("nord"), "dark", "system")).toBe(first);
    expect(syntaxThemeFor(theme("monokai"), "dark", "dark")).not.toBe(first);
  });

  it("only names themes shiki actually bundles", () => {
    expect(NAMED.length).toBeGreaterThan(0);
    expect(
      NAMED.filter((n) => !SHIKI_THEMES.has(n.syntax)).map((n) => n.label),
    ).toEqual([]);
  });

  it("keeps a named syntax theme on its palette's side", () => {
    // A dark palette paired with a light syntax theme would read as a bright
    // code block on a dark page, which is the T-144 bug inverted.
    const light = (name: string) =>
      name.includes("light") ||
      name === "catppuccin-latte" ||
      name === "rose-pine-dawn";
    expect(
      NAMED.filter((n) => light(n.syntax) !== (n.scheme === "light")).map(
        (n) => `${n.label} → ${n.syntax}`,
      ),
    ).toEqual([]);
  });
});

describe("useSyntaxTheme", () => {
  it("follows the store's pick, also when it changes", () => {
    const { store, result, rerender } = renderSyntax();
    expect(result.current).toBe(PIERRE_THEME);
    act(() => store.setPref({ ui: { theme: "nord", mode: "dark" } }));
    rerender();
    expect(result.current).toEqual({ light: "nord", dark: "nord" });
    act(() => store.setPref({ ui: { theme: "github", mode: "system" } }));
    rerender();
    expect(result.current).toEqual({
      light: "github-light",
      dark: "github-dark",
    });
  });
});
