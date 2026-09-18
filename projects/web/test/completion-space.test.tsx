import type { Completion } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyWithSpace,
  attachesLeft,
  pendingSpaceAt,
  spaceAfterAccept,
} from "../src/lib/editor/completion-space.ts";
import { handleViewInput } from "./cm.ts";

const openViews: EditorView[] = [];

afterEach(() => {
  for (const view of openViews.splice(0)) view.destroy();
});

function accepted(doc = "@al", text = "@alice", from = 0, to = 3): EditorView {
  const parent = document.createElement("div");
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: to },
      extensions: [history(), spaceAfterAccept],
    }),
  });
  openViews.push(view);
  const option: Completion = { label: text, apply: applyWithSpace(text) };
  const apply = option.apply;
  if (typeof apply !== "function") throw new Error("expected functional apply");
  apply(view, option, from, to);
  return view;
}

function defaultInput(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.type",
  });
}

function input(view: EditorView, text: string): boolean {
  const handled = handleViewInput(view, text);
  if (!handled) defaultInput(view, text);
  return handled;
}

const docOf = (view: EditorView) => view.state.doc.toString();

describe("attachesLeft", () => {
  it.each([
    "，",
    "。",
    "、",
    "；",
    "：",
    "！",
    "？",
    "～",
    "…",
    ",",
    ".",
    ";",
    ":",
    "!",
    "?",
    "~",
    ")",
    "）",
    "」",
    "》",
    "”",
    "’",
  ])("attaches %s to the token on its left", (char) => {
    expect(attachesLeft(char)).toBe(true);
  });

  it.each([
    "'",
    '"',
    "(",
    "（",
    "“",
    "「",
    "@",
    "#",
    "*",
    "-",
    "/",
    "你",
    "a",
    "1",
    "",
    "。，",
  ])("leaves a separator before %s", (char) => {
    expect(attachesLeft(char)).toBe(false);
  });
});

describe("pending completion spaces", () => {
  it("inserts one visible pending space with the caret after it", () => {
    const view = accepted();
    expect(docOf(view)).toBe("@alice ");
    expect(view.state.selection.main.anchor).toBe(7);
    expect(pendingSpaceAt(view.state)).toBe(6);
  });

  it.each([" ", "\t"])(
    "uses existing right whitespace %j without making it pending",
    (whitespace) => {
      const view = accepted(`@al${whitespace}bob`);
      expect(docOf(view)).toBe(`@alice${whitespace}bob`);
      expect(view.state.selection.main.anchor).toBe(7);
      expect(pendingSpaceAt(view.state)).toBeNull();
    },
  );

  it("replaces the pending space with left-attaching punctuation", () => {
    const view = accepted();
    expect(input(view, "，")).toBe(true);
    expect(docOf(view)).toBe("@alice，");
    expect(view.state.selection.main.anchor).toBe(7);
    expect(pendingSpaceAt(view.state)).toBeNull();
  });

  it("eats only the first extra space", () => {
    const view = accepted();
    expect(input(view, " ")).toBe(true);
    expect(docOf(view)).toBe("@alice ");
    expect(pendingSpaceAt(view.state)).toBeNull();
    expect(input(view, " ")).toBe(false);
    expect(docOf(view)).toBe("@alice  ");
  });

  it.each(["你", "你，"])("keeps the separator before %s", (text) => {
    const view = accepted();
    expect(input(view, text)).toBe(false);
    expect(docOf(view)).toBe(`@alice ${text}`);
    expect(pendingSpaceAt(view.state)).toBeNull();
  });

  it("does not revive pending state after the caret moves away", () => {
    const view = accepted();
    view.dispatch({ selection: { anchor: 0 } });
    view.dispatch({ selection: { anchor: 7 } });
    expect(input(view, "，")).toBe(false);
    expect(docOf(view)).toBe("@alice ，");
  });

  it("uses the same rule for reference completions", () => {
    const view = accepted("T-1", "T-12", 0, 3);
    expect(input(view, "。")).toBe(true);
    expect(docOf(view)).toBe("T-12。");
  });

  it("undoes accepting a completion back to the exact typed bytes", () => {
    const view = accepted();
    expect(undo(view)).toBe(true);
    expect(docOf(view)).toBe("@al");
    expect(view.state.selection.main.anchor).toBe(3);
    expect(pendingSpaceAt(view.state)).toBeNull();
  });
});

describe("IME composition boundaries", () => {
  it("does not handle even the composition-started, not-yet-composing stage", () => {
    const view = accepted();
    fireEvent.compositionStart(view.contentDOM);
    expect(view.compositionStarted).toBe(true);
    expect(view.composing).toBe(false);

    const dispatch = vi.spyOn(view, "dispatch");
    expect(handleViewInput(view, "，")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(docOf(view)).toBe("@alice ");
    expect(pendingSpaceAt(view.state)).toBe(6);
    dispatch.mockRestore();

    defaultInput(view, "，");
    expect(docOf(view)).toBe("@alice ，");
    expect(pendingSpaceAt(view.state)).toBeNull();
  });

  it("handles end input only while an unchanged pending space is valid", () => {
    const view = accepted();
    fireEvent.compositionStart(view.contentDOM);
    fireEvent.compositionEnd(view.contentDOM);
    expect(view.compositionStarted).toBe(false);
    expect(handleViewInput(view, "，")).toBe(true);
    expect(docOf(view)).toBe("@alice，");
  });

  it("does not restore pending state after an active composition changed the doc", () => {
    const view = accepted();
    fireEvent.compositionStart(view.contentDOM);
    defaultInput(view, "你");
    expect(pendingSpaceAt(view.state)).toBeNull();
    fireEvent.compositionEnd(view.contentDOM);
    expect(handleViewInput(view, "，")).toBe(false);
    defaultInput(view, "，");
    expect(docOf(view)).toBe("@alice 你，");
  });

  it("leaves a multi-character end candidate separated and clears pending", () => {
    const view = accepted();
    fireEvent.compositionStart(view.contentDOM);
    fireEvent.compositionEnd(view.contentDOM);
    expect(handleViewInput(view, "你好，")).toBe(false);
    defaultInput(view, "你好，");
    expect(docOf(view)).toBe("@alice 你好，");
    expect(pendingSpaceAt(view.state)).toBeNull();
  });

  it("keeps pending state when composition is cancelled without a change", () => {
    const view = accepted();
    fireEvent.compositionStart(view.contentDOM);
    fireEvent.compositionEnd(view.contentDOM);
    expect(pendingSpaceAt(view.state)).toBe(6);
    expect(input(view, "，")).toBe(true);
    expect(docOf(view)).toBe("@alice，");
  });
});
