import { history, undo } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { toggleQuote } from "../src/lib/editor/quote-toggle.ts";

function run(
  doc: string,
  selection: EditorSelection,
): { state: EditorState; before: EditorState } {
  const before = EditorState.create({
    doc,
    selection,
    extensions: [history(), EditorState.allowMultipleSelections.of(true)],
  });
  let state = before;
  const dispatch = (tr: Transaction) => {
    state = tr.state;
  };
  expect(toggleQuote({ state, dispatch })).toBe(true);
  return { state, before };
}

describe("toggleQuote", () => {
  it("quotes every line when only some are quoted already", () => {
    const { state } = run(
      "> one\ntwo\n> three",
      EditorSelection.create([EditorSelection.range(0, 17)]),
    );
    expect(state.doc.toString()).toBe("> > one\n> two\n> > three");
  });

  it("takes one level off when every non-blank line is quoted", () => {
    const { state } = run(
      "> one\n\n>two\n> > three",
      EditorSelection.create([EditorSelection.range(0, 21)]),
    );
    expect(state.doc.toString()).toBe("one\n\ntwo\n> three");
  });

  it("works on the cursor's line when nothing is selected", () => {
    const { state } = run(
      "one\ntwo",
      EditorSelection.create([EditorSelection.cursor(5)]),
    );
    expect(state.doc.toString()).toBe("one\n> two");
    expect(state.selection.main.head).toBe(7);
  });

  it("turns a blank line into a bare marker and back", () => {
    const quoted = run(
      "a\n\nb",
      EditorSelection.create([EditorSelection.range(0, 4)]),
    ).state;
    expect(quoted.doc.toString()).toBe("> a\n>\n> b");
    const { state } = run(
      quoted.doc.toString(),
      EditorSelection.create([EditorSelection.range(0, quoted.doc.length)]),
    );
    expect(state.doc.toString()).toBe("a\n\nb");
  });

  it("does not take the line a selection ends at the very start of", () => {
    const { state } = run(
      "one\ntwo",
      EditorSelection.create([EditorSelection.range(0, 4)]),
    );
    expect(state.doc.toString()).toBe("> one\ntwo");
  });

  it("handles two cursors in separate paragraphs in one step", () => {
    const { state, before } = run(
      "first\n\nmiddle\n\nlast",
      EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(17),
      ]),
    );
    expect(state.doc.toString()).toBe("> first\n\nmiddle\n\n> last");
    expect(state.selection.ranges.map((r) => r.head)).toEqual([4, 21]);

    let undone = state;
    undo({
      state,
      dispatch: (tr) => {
        undone = tr.state;
      },
    });
    expect(undone.doc.toString()).toBe(before.doc.toString());
  });
});
