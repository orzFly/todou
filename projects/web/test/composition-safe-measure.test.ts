import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compositionSafeMeasure } from "../src/lib/editor/composition-safe-measure.ts";

// Both casts reach @codemirror/view internals the module under test also
// depends on; a CodeMirror that renames them fails these tests first.
type Internals = {
  docView: {
    measureTextSize(): {
      lineHeight: number;
      charWidth: number;
      textHeight: number;
    };
  };
  inputState: { composing: number };
};

const openViews: EditorView[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const view of openViews.splice(0)) view.destroy();
});

// No line is short and ASCII-only, so measuring has to append a dummy line.
function cjkEditor(): EditorView & Internals {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc: "内存可能数个版本才需要更新一次",
      extensions: [compositionSafeMeasure],
    }),
  });
  openViews.push(view);
  // The plugin is built before the view's DocView exists, so it installs on
  // the first update.
  view.dispatch({});
  return view as EditorView & Internals;
}

describe("compositionSafeMeasure", () => {
  it("leaves the contenteditable alone while a composition is open", () => {
    const view = cjkEditor();
    const append = vi.spyOn(view.contentDOM, "appendChild");
    view.inputState.composing = 0;

    expect(view.docView.measureTextSize()).toEqual({
      lineHeight: 0,
      charWidth: 0,
      textHeight: 0,
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("measures as before outside a composition", () => {
    const view = cjkEditor();
    const append = vi.spyOn(view.contentDOM, "appendChild");

    view.docView.measureTextSize();

    expect(append).toHaveBeenCalledOnce();
    // The dummy line is gone again: measuring never leaves DOM behind.
    expect(view.contentDOM.querySelectorAll(".cm-line")).toHaveLength(1);
  });
});
