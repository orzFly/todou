import { redo, undo } from "@codemirror/commands";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  type EditorFileStaging,
  MarkdownEditor,
} from "../src/components/shared/markdown-editor.tsx";
import { cmGetValue, cmPressKey, cmView } from "./cm.ts";

const TOKEN = "![shot.png](staged:1)";

/** An editor that staged key 1 and nothing else, caret at `caret`. */
function mount(doc: string, caret: number) {
  const staging: EditorFileStaging = {
    bind: () => {},
    sync: () => {},
    knows: (key) => key === 1,
    paste: () => {},
    drop: () => false,
    dragOver: () => {},
  };
  const view = render(<MarkdownEditor initialValue={doc} staging={staging} />);
  const cm = cmView(view.container);
  cm.dispatch({ selection: { anchor: caret } });
  return { root: view.container, cm };
}

describe("a staged-file token is one unit", () => {
  it("goes in one Backspace from just after it", () => {
    const doc = `a ${TOKEN} b`;
    const { root } = mount(doc, 2 + TOKEN.length);
    cmPressKey(root, "Backspace");
    expect(cmGetValue(root)).toBe("a  b");
  });

  it("goes in one Delete from just before it", () => {
    const { root } = mount(`a ${TOKEN} b`, 2);
    cmPressKey(root, "Delete");
    expect(cmGetValue(root)).toBe("a  b");
  });

  it("is stepped over by one ArrowLeft", () => {
    const { root, cm } = mount(`a ${TOKEN} b`, 2 + TOKEN.length);
    cmPressKey(root, "ArrowLeft");
    expect(cm.state.selection.main.head).toBe(2);
  });

  it("is ordinary text inside inline code", () => {
    const doc = `\`${TOKEN}\``;
    const { root } = mount(doc, doc.length - 1);
    cmPressKey(root, "Backspace");
    expect(cmGetValue(root)).toBe(`\`${TOKEN.slice(0, -1)}\``);
  });

  it("sends an insertion inside it to its end", () => {
    const doc = `a ${TOKEN} b`;
    const { cm } = mount(doc, 0);
    cm.dispatch({
      changes: { from: 2 + "![shot.".length, insert: "z" },
      userEvent: "input.type",
    });
    expect(cm.state.doc.toString()).toBe(`a ${TOKEN}z b`);
  });

  it("is replaced whole by an edit to part of it, and undoes verbatim", () => {
    const doc = `a ${TOKEN} b`;
    const { cm } = mount(doc, 0);
    const png = 2 + TOKEN.indexOf("png");
    cm.dispatch({
      changes: { from: png, to: png + 3, insert: "z" },
      userEvent: "input.type",
    });
    expect(cm.state.doc.toString()).toBe("a z b");
    undo(cm);
    expect(cm.state.doc.toString()).toBe(doc);
    redo(cm);
    expect(cm.state.doc.toString()).toBe("a z b");
  });

  it("lets undo take back an edit beside it without growing it", () => {
    const doc = "a [x](staged:1)";
    const { cm } = mount(doc, 0);
    cm.dispatch({
      changes: { from: 2, insert: "!" },
      userEvent: "input.type",
    });
    expect(cm.state.doc.toString()).toBe("a ![x](staged:1)");
    undo(cm);
    expect(cm.state.doc.toString()).toBe(doc);
  });

  it("puts the caret after an insertion it moved out of the token", () => {
    const { cm } = mount(`a ${TOKEN} b`, 0);
    const inside = 2 + "![shot.".length;
    cm.dispatch({
      changes: { from: inside, insert: "z" },
      selection: { anchor: inside + 1 },
      userEvent: "input.type",
    });
    expect(cm.state.doc.toString()).toBe(`a ${TOKEN}z b`);
    expect(cm.state.selection.main.head).toBe(2 + TOKEN.length + 1);
  });

  it("wears a chip, which other links and unknown keys do not", () => {
    const attachment = "![x](/api/projects/p/attachments/1/download/x.png)";
    const unknown = "![x](staged:9)";
    const { cm } = mount(`${TOKEN} ${attachment} ${unknown}`, 0);
    const chips = [...cm.contentDOM.querySelectorAll(".cm-staged-token")];
    expect(chips.map((chip) => chip.textContent)).toEqual([TOKEN]);
  });

  it("leaves an unknown key's link to ordinary Backspace", () => {
    const doc = "a ![x](staged:9)";
    const { root } = mount(doc, doc.length);
    cmPressKey(root, "Backspace");
    expect(cmGetValue(root)).toBe("a ![x](staged:9");
  });
});
