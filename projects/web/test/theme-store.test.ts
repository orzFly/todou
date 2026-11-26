import type { ThemeStore } from "@orz/ui/theme";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTodouThemeStore,
  THEME_STORAGE_KEY,
} from "../src/lib/theme-store.ts";

// A fresh storage per case. Spies on happy-dom's Storage, on the prototype or
// on the instance, are never called, so the whole global is swapped instead.
function stubStorage(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  });
  return data;
}

let store: ThemeStore | undefined;

afterEach(() => {
  store?.dispose();
  store = undefined;
  vi.unstubAllGlobals();
});

describe("todou's theme store", () => {
  it("reads a preference saved before @orz/ui as its theme and mode", () => {
    const data = stubStorage({ [THEME_STORAGE_KEY]: "solarized-dark" });
    store = createTodouThemeStore();
    expect(store.getResolved()?.theme.id).toBe("solarized");
    expect(store.getResolved()?.colorScheme).toBe("dark");
    expect(store.getPref().ui).toEqual({ theme: "solarized", mode: "dark" });
    // Kept as written until the next pick, which writes JSON.
    store.setPref(store.getPref());
    expect(JSON.parse(data.get(THEME_STORAGE_KEY) ?? "null")).toMatchObject({
      ui: { theme: "solarized", mode: "dark" },
    });
  });

  it("offers the default style alone", () => {
    stubStorage({});
    store = createTodouThemeStore();
    expect(store.getStyles().map((s) => s.id)).toEqual(["default"]);
    expect(store.getStyle()).toBe("default");
  });
});
