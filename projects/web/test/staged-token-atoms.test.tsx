import { redo, undo } from "@codemirror/commands";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  type EditorFileStaging,
  MarkdownEditor,
} from "../src/components/shared/markdown-editor.tsx";
import { cmGetValue, cmPressKey, cmView } from "./cm.ts";

const TOKEN = "![shot.png](staged:1-k3f9)";

/** An editor that staged `1-k3f9` and nothing else, caret at `caret`. */
function mount(doc: string, caret: number) {
  const staging: EditorFileStaging = {
    bind: () => {},
    sync: () => {},
    knows: (key) => key === "1-k3f9",
    paste: () => {},
    drop: () => false,
    dragOver: () => {},
  };
  const view = render(<MarkdownEditor initialValue={doc} staging={staging} />);
  const cm = cmView(view.container);
  cm.dispatch({ selection: { anchor: caret } });
  return { root: view.container, cm };
}

describe("a staged-file token is one unit with its spaces", () => {
  const doc = `a ${TOKEN} b`;
  const end = 3 + TOKEN.length;

  it("goes in one Backspace from just after it", () => {
    const { root, cm } = mount(doc, end);
    cmPressKey(root, "Backspace");
    expect(cmGetValue(root)).toBe("a b");
    expect(cm.state.selection.main.head).toBe(2);
    undo(cm);
    expect(cmGetValue(root)).toBe(doc);
  });

  it("goes in one Delete from just before it", () => {
    const { root, cm } = mount(doc, 1);
    cmPressKey(root, "Delete");
    expect(cmGetValue(root)).toBe("a b");
    expect(cm.state.selection.main.head).toBe(1);
  });

  it("joins Chinese, Japanese and Korean text with no space", () => {
    const { root } = mount(`看 ${TOKEN} 你`, 3 + TOKEN.length);
    cmPressKey(root, "Backspace");
    expect(cmGetValue(root)).toBe("看你");
  });

  it("takes it out clean beside whitespace", () => {
    const { root } = mount(`a ${TOKEN} `, end);
    cmPressKey(root, "Backspace");
    expect(cmGetValue(root)).toBe("a");
  });

  it("is stepped over by one ArrowLeft", () => {
    const { root, cm } = mount(doc, end);
    cmPressKey(root, "ArrowLeft");
    expect(cm.state.selection.main.head).toBe(1);
    cmPressKey(root, "ArrowRight");
    expect(cm.state.selection.main.head).toBe(end);
  });

  it("keeps an edit to its spaces alone outside it", () => {
    const after = mount(`a ${TOKEN} `, end);
    cmPressKey(after.root, "Enter");
    expect(cmGetValue(after.root)).toBe(`a ${TOKEN} \n`);
    expect(after.cm.state.selection.main.head).toBe(end + 1);
    const before = mount(` ${TOKEN} b`, 0);
    cmPressKey(before.root, "Enter");
    expect(cmGetValue(before.root)).toBe(`\n ${TOKEN} b`);
  });

  it("takes the whole unit for an edit that reaches its token's edge", () => {
    const close = 2 + TOKEN.length - 1;
    for (const [from, to] of [
      [close, close + 2],
      [close, close + 1],
      [1, 3],
    ]) {
      const { cm } = mount(doc, 0);
      cm.dispatch({ changes: { from, to }, userEvent: "delete" });
      expect(cm.state.doc.toString()).toBe("a b");
    }
  });

  it("keeps the unit before when one edit reaches into the next token", () => {
    const two = ` ${TOKEN}  ${TOKEN} `;
    const { cm } = mount(two, 0);
    const from = 1 + TOKEN.length;
    cm.dispatch({ changes: { from, to: from + 4 }, userEvent: "delete" });
    expect(cm.state.doc.toString()).toBe(` ${TOKEN} `);
  });

  it("spaces only a deletion of whole units, judged on the run's outer sides", () => {
    const mixed = mount(`foo bar ${TOKEN} baz`, 0);
    mixed.cm.dispatch({ selection: { anchor: 5, head: 9 + TOKEN.length } });
    cmPressKey(mixed.root, "Backspace");
    expect(cmGetValue(mixed.root)).toBe("foo bbaz");
    const run = mount(`a ${TOKEN}  ${TOKEN} b`, 0);
    run.cm.dispatch({ selection: { anchor: 1, head: 5 + 2 * TOKEN.length } });
    cmPressKey(run.root, "Backspace");
    expect(cmGetValue(run.root)).toBe("a b");
  });

  it("is ordinary text inside inline code", () => {
    const doc = `\`${TOKEN}\``;
    const { root } = mount(doc, doc.length - 1);
    cmPressKey(root, "Backspace");
    expect(cmGetValue(root)).toBe(`\`${TOKEN.slice(0, -1)}\``);
  });

  it("sends an insertion inside it to its end", () => {
    for (const inside of [2 + "![shot.".length, 2 + TOKEN.length, 2]) {
      const { cm } = mount(doc, 0);
      cm.dispatch({
        changes: { from: inside, insert: "z" },
        userEvent: "input.type",
      });
      expect(cm.state.doc.toString()).toBe(`a ${TOKEN} zb`);
    }
  });

  it("is replaced whole by an edit to part of it, and undoes verbatim", () => {
    const { cm } = mount(doc, 0);
    const png = 2 + TOKEN.indexOf("png");
    cm.dispatch({
      changes: { from: png, to: png + 3, insert: "z" },
      userEvent: "input.type",
    });
    expect(cm.state.doc.toString()).toBe("azb");
    undo(cm);
    expect(cm.state.doc.toString()).toBe(doc);
    redo(cm);
    expect(cm.state.doc.toString()).toBe("azb");
  });

  it("lets undo take back an edit beside it without growing it", () => {
    const link = "[x](staged:1-k3f9)";
    const { cm } = mount(link, 0);
    cm.dispatch({
      changes: { from: 0, insert: "!" },
      userEvent: "input.type",
    });
    expect(cm.state.doc.toString()).toBe(`!${link}`);
    undo(cm);
    expect(cm.state.doc.toString()).toBe(link);
  });

  it("puts the caret after an insertion it moved out of the token", () => {
    const { cm } = mount(doc, 0);
    const inside = 2 + "![shot.".length;
    cm.dispatch({
      changes: { from: inside, insert: "z" },
      selection: { anchor: inside + 1 },
      userEvent: "input.type",
    });
    expect(cm.state.doc.toString()).toBe(`a ${TOKEN} zb`);
    expect(cm.state.selection.main.head).toBe(end + 1);
  });

  it("wears a chip, which other links and unknown keys do not", () => {
    const attachment = "![x](/api/projects/p/attachments/1/download/x.png)";
    const unknown = "![x](staged:9-k3f9)";
    const { cm } = mount(`${TOKEN} ${attachment} ${unknown}`, 0);
    const chips = [...cm.contentDOM.querySelectorAll(".cm-staged-token")];
    expect(chips.map((chip) => chip.textContent)).toEqual([TOKEN]);
  });

  it("leaves an unknown key's link to ordinary Backspace", () => {
    const doc = "a ![x](staged:9-k3f9)";
    const { root } = mount(doc, doc.length);
    cmPressKey(root, "Backspace");
    expect(cmGetValue(root)).toBe("a ![x](staged:9-k3f9");
  });
});
