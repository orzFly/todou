import { EditorView } from "@codemirror/view";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownEditor } from "../src/components/shared/markdown-editor.tsx";
import { setThemePref } from "../src/lib/theme.ts";
import { cmView } from "./cm.ts";

afterEach(() => {
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
});
