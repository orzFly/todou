import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PIERRE_THEME,
  useSyntaxTheme,
} from "../src/components/shared/pierre.tsx";
import {
  setThemePref,
  syntaxThemeOf,
  THEMES,
  type Theme,
} from "../src/lib/theme.ts";

afterEach(() => {
  setThemePref("system");
  localStorage.clear();
});

// Copied verbatim from @pierre/theming's shiki collection rather than
// imported: a name absent from it throws UnregisteredThemeError at render
// time, and importing the real list would let an upstream rename silently
// take our mapping with it.
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

const EXPECTED: Record<string, string | undefined> = {
  light: undefined,
  "pico-light": undefined,
  "solarized-light": "solarized-light",
  "vs-light": "light-plus",
  "github-light": "github-light",
  "catppuccin-latte": "catppuccin-latte",
  "gruvbox-light": "gruvbox-light-medium",
  dark: undefined,
  "tera-dark": undefined,
  "solarized-dark": "solarized-dark",
  "vs-dark": "dark-plus",
  "github-dark": "github-dark",
  dracula: "dracula",
  nord: "nord",
  "tokyo-night": "tokyo-night",
  "one-dark": "one-dark-pro",
  monokai: "monokai",
  "catppuccin-mocha": "catppuccin-mocha",
  "gruvbox-dark": "gruvbox-dark-medium",
};

describe("syntaxThemeOf", () => {
  it("maps every theme to its expected syntax theme", () => {
    for (const theme of THEMES) {
      expect(syntaxThemeOf(theme.value)).toBe(EXPECTED[theme.value]);
    }
  });

  it("covers every theme, so a new one cannot slip in unmapped", () => {
    expect(THEMES.map((t) => t.value).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
  });

  it("only names themes shiki actually bundles", () => {
    for (const theme of THEMES) {
      const syntax = syntaxThemeOf(theme.value);
      if (syntax === undefined) continue;
      expect(SHIKI_THEMES.has(syntax)).toBe(true);
    }
  });

  it("keeps a mapped syntax theme on the same side as the app theme", () => {
    // A dark app theme paired with a light syntax theme would read as a
    // bright code block on a dark page, which is the T-144 bug inverted.
    for (const theme of THEMES) {
      const syntax = syntaxThemeOf(theme.value);
      if (syntax === undefined) continue;
      expect(syntax.includes("light") || syntax === "catppuccin-latte").toBe(
        theme.kind === "light",
      );
    }
  });
});

describe("useSyntaxTheme", () => {
  it("keeps pierre's own pair under the system preference", () => {
    setThemePref("system");
    const { result } = renderHook(() => useSyntaxTheme());
    expect(result.current).toBe(PIERRE_THEME);
  });

  it("fills both slots with the mapped theme", () => {
    setThemePref("solarized-light");
    const { result } = renderHook(() => useSyntaxTheme());
    expect(result.current).toEqual({
      light: "solarized-light",
      dark: "solarized-light",
    });
  });

  it("falls back to pierre for a theme with no upstream counterpart", () => {
    setThemePref("pico-light");
    const { result } = renderHook(() => useSyntaxTheme());
    expect(result.current).toBe(PIERRE_THEME);
  });

  it("returns one object per theme, so pierre sees stable options", () => {
    setThemePref("dracula");
    const first = renderHook(() => useSyntaxTheme());
    const second = renderHook(() => useSyntaxTheme());
    expect(first.result.current).toBe(second.result.current);
    first.rerender();
    expect(first.result.current).toBe(second.result.current);
  });

  it("hands out a different object when the theme changes", () => {
    setThemePref("nord");
    const { result, rerender } = renderHook(() => useSyntaxTheme());
    const nord = result.current;
    setThemePref("monokai");
    rerender();
    expect(result.current).not.toBe(nord);
    expect(result.current.light).toBe("monokai");
  });
});

describe("THEMES", () => {
  it("never maps two app themes to the same syntax theme", () => {
    // Not a correctness requirement of pierre's, but a duplicate is always
    // a copy-paste slip in a table this repetitive.
    const mapped = THEMES.map((t) => syntaxThemeOf(t.value as Theme)).filter(
      (s): s is string => s !== undefined,
    );
    expect(new Set(mapped).size).toBe(mapped.length);
  });
});
