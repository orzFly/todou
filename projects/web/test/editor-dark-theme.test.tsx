import { EditorView } from "@codemirror/view";
import { ThemeProvider, type ThemeStore } from "@orz/ui/theme";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownEditor } from "../src/components/shared/markdown-editor.tsx";
import { createTodouThemeStore } from "../src/lib/theme-store.ts";
import { cmView } from "./cm.ts";

/** The OS colour scheme happy-dom answers `prefers-color-scheme` from. */
const device = (
  window as unknown as {
    happyDOM: { settings: { device: { prefersColorScheme: string } } };
  }
).happyDOM.settings.device;

/** Switch the OS scheme; happy-dom re-evaluates media queries on resize. */
function setOsScheme(scheme: "light" | "dark") {
  device.prefersColorScheme = scheme;
  window.dispatchEvent(new Event("resize"));
}

let store: ThemeStore | undefined;

function renderEditor() {
  store = createTodouThemeStore();
  const view = render(
    <ThemeProvider store={store}>
      <MarkdownEditor />
    </ThemeProvider>,
  );
  return { store, view: cmView(view.container) };
}

afterEach(() => {
  store?.dispose();
  store = undefined;
  setOsScheme("light");
  localStorage.clear();
});

describe("editor light/dark", () => {
  it("follows the app's dark theme, also when it changes while mounted", () => {
    const { store, view } = renderEditor();
    act(() => store.setPref({ ui: { theme: "github", mode: "dark" } }));
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);

    act(() => store.setPref({ ui: { theme: "default", mode: "light" } }));
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  });

  it("follows the OS under the system preference, also while mounted", () => {
    // Created under a light OS: happy-dom's MediaQueryList assumes a listener
    // starts out not matching, so one added under a dark OS never hears the
    // switch back.
    const { store, view } = renderEditor();
    act(() => store.setPref({ ui: { theme: "default", mode: "system" } }));
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);

    act(() => setOsScheme("dark"));
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);

    act(() => setOsScheme("light"));
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  });
});
