import { EditorView } from "@codemirror/view";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownEditor } from "../src/components/shared/markdown-editor.tsx";
import { setThemePref } from "../src/lib/theme.ts";
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

afterEach(() => {
  setOsScheme("light");
  setThemePref("system");
  localStorage.clear();
});

describe("editor light/dark", () => {
  it("follows the app's dark theme, also when it changes while mounted", () => {
    setThemePref("github-dark");
    const { container } = render(<MarkdownEditor />);
    const view = cmView(container);
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);

    act(() => setThemePref("light"));
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  });

  it("follows the OS under the system preference, also while mounted", () => {
    setThemePref("system");
    setOsScheme("dark");
    const { container } = render(<MarkdownEditor />);
    const view = cmView(container);
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);

    act(() => setOsScheme("light"));
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  });
});
