import { useSyncExternalStore } from "react";

export type ThemeKind = "light" | "dark";

export interface ThemeDef {
  /** data-theme slug applied to <html>; "light"/"dark" are the defaults with no block. */
  value: string;
  label: string;
  kind: ThemeKind;
  /** Menu swatch halves (oklch literals). */
  surface: string;
  accent: string;
}

// The todou defaults lead each group; the rest are the picotera ports (#36).
// Adding a theme = one entry here + one :root[data-theme='…'] block in
// styles.css.
export const THEMES = [
  {
    value: "light",
    label: "todou Light",
    kind: "light",
    surface: "oklch(1 0 0)",
    accent: "oklch(0.205 0 0)",
  },
  {
    value: "pico-light",
    label: "Pico Light",
    kind: "light",
    surface: "oklch(0.986 0.003 250)",
    accent: "oklch(0.54 0.19 262)",
  },
  {
    value: "solarized-light",
    label: "Solarized Light",
    kind: "light",
    surface: "oklch(0.965 0.036 92)",
    accent: "oklch(0.72 0.15 85)",
  },
  {
    value: "vs-light",
    label: "Visual Studio Light",
    kind: "light",
    surface: "oklch(0.985 0.001 250)",
    accent: "oklch(0.5 0.16 250)",
  },
  {
    value: "github-light",
    label: "GitHub Light",
    kind: "light",
    surface: "oklch(0.985 0.002 250)",
    accent: "oklch(0.55 0.18 255)",
  },
  {
    value: "catppuccin-latte",
    label: "Catppuccin Latte",
    kind: "light",
    surface: "oklch(0.97 0.005 280)",
    accent: "oklch(0.52 0.22 300)",
  },
  {
    value: "gruvbox-light",
    label: "Gruvbox Light",
    kind: "light",
    surface: "oklch(0.95 0.04 95)",
    accent: "oklch(0.48 0.09 220)",
  },
  {
    value: "dark",
    label: "todou Dark",
    kind: "dark",
    surface: "oklch(0.145 0 0)",
    accent: "oklch(0.922 0 0)",
  },
  {
    value: "tera-dark",
    label: "Tera Dark",
    kind: "dark",
    surface: "oklch(0.22 0.02 255)",
    accent: "oklch(0.70 0.18 262)",
  },
  {
    value: "solarized-dark",
    label: "Solarized Dark",
    kind: "dark",
    surface: "oklch(0.30 0.035 210)",
    accent: "oklch(0.68 0.14 235)",
  },
  {
    value: "vs-dark",
    label: "Visual Studio Dark",
    kind: "dark",
    surface: "oklch(0.26 0.004 250)",
    accent: "oklch(0.62 0.15 245)",
  },
  {
    value: "github-dark",
    label: "GitHub Dark",
    kind: "dark",
    surface: "oklch(0.2 0.015 260)",
    accent: "oklch(0.65 0.17 255)",
  },
  {
    value: "dracula",
    label: "Dracula",
    kind: "dark",
    surface: "oklch(0.31 0.028 285)",
    accent: "oklch(0.74 0.16 300)",
  },
  {
    value: "nord",
    label: "Nord",
    kind: "dark",
    surface: "oklch(0.33 0.022 250)",
    accent: "oklch(0.78 0.08 210)",
  },
  {
    value: "tokyo-night",
    label: "Tokyo Night",
    kind: "dark",
    surface: "oklch(0.24 0.025 270)",
    accent: "oklch(0.7 0.15 265)",
  },
  {
    value: "one-dark",
    label: "One Dark",
    kind: "dark",
    surface: "oklch(0.31 0.012 265)",
    accent: "oklch(0.72 0.14 245)",
  },
  {
    value: "monokai",
    label: "Monokai",
    kind: "dark",
    surface: "oklch(0.27 0.012 110)",
    accent: "oklch(0.78 0.13 195)",
  },
  {
    value: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    kind: "dark",
    surface: "oklch(0.26 0.03 285)",
    accent: "oklch(0.78 0.13 300)",
  },
  {
    value: "gruvbox-dark",
    label: "Gruvbox Dark",
    kind: "dark",
    surface: "oklch(0.28 0.008 90)",
    accent: "oklch(0.74 0.13 60)",
  },
] as const satisfies readonly ThemeDef[];

export type Theme = (typeof THEMES)[number]["value"];
/** What the user picked; "system" resolves to the todou defaults per OS. */
export type ThemePref = Theme | "system";

const THEME_VALUES = THEMES.map((t) => t.value) as Theme[];

export function themeKind(value: Theme): ThemeKind {
  return THEMES.find((t) => t.value === value)?.kind ?? "light";
}

export const THEME_STORAGE_KEY = "todou-theme";
// The resolved kind is persisted separately so the index.html paint guard
// can set .dark without knowing which slugs are dark.
export const THEME_KIND_STORAGE_KEY = "todou-theme-kind";

const media: MediaQueryList | null =
  typeof window === "undefined"
    ? null
    : window.matchMedia("(prefers-color-scheme: dark)");

function readPref(): ThemePref {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "system" || THEME_VALUES.includes(raw as Theme)) {
      return raw as ThemePref;
    }
  } catch {
    // storage may be unavailable (private mode); fall through
  }
  return "system";
}

export function resolveTheme(pref: ThemePref): Theme {
  if (pref !== "system") return pref;
  return media?.matches ? "dark" : "light";
}

let pref: ThemePref = readPref();
const listeners = new Set<() => void>();

function applyTheme() {
  const theme = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", themeKind(theme) === "dark");
}

function notify() {
  for (const l of listeners) l();
}

export function setThemePref(next: ThemePref) {
  pref = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    if (next === "system") {
      localStorage.removeItem(THEME_KIND_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_KIND_STORAGE_KEY, themeKind(next));
    }
  } catch {
    // preference just won't persist
  }
  applyTheme();
  notify();
}

if (media) {
  applyTheme();
  media.addEventListener("change", () => {
    if (pref === "system") {
      applyTheme();
      notify();
    }
  });
  // Keep multiple open tabs in step.
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_STORAGE_KEY) {
      pref = readPref();
      applyTheme();
      notify();
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    subscribe,
    () => pref,
    () => pref,
  );
}
