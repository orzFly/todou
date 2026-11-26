import { builtinThemes } from "@orz/themes";
import { createThemeStore } from "@orz/ui/theme";

/**
 * The key todou has always kept the theme under. The store reads the slugs
 * written before @orz/ui (`"dark"`, `"solarized-light"`, …) as their themes
 * and rewrites them as JSON on the next pick.
 */
export const THEME_STORAGE_KEY = "todou-theme";

// No `styles`: the default style alone, so a theme that belongs only to
// another style never reaches the menu.
export function createTodouThemeStore() {
  return createThemeStore({
    storageKey: THEME_STORAGE_KEY,
    themes: builtinThemes,
  });
}

export const themeStore = createTodouThemeStore();
