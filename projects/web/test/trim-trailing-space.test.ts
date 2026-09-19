import type * as CodeMirrorLanguage from "@codemirror/language";
import {
  type IndentContext,
  indentService,
  indentUnit,
} from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";

const syntaxTreeMock = vi.hoisted(() => vi.fn());
vi.mock("@codemirror/language", async (importOriginal) => ({
  ...(await importOriginal<typeof CodeMirrorLanguage>()),
  syntaxTree: syntaxTreeMock,
}));

import {
  trailingRunToTrim,
  trimTrailingSpaceOnEnter,
} from "../src/lib/editor/trim-trailing-space.ts";

const treeAt = (length: number, name = "Paragraph") => ({
  length,
  resolveInner: () => ({ name, parent: null }),
});

beforeEach(() => {
  syntaxTreeMock.mockReset();
  syntaxTreeMock.mockReturnValue(treeAt(100));
});

describe("trailingRunToTrim", () => {
  it.each([
    ["foo|", "foo", 3, null],
    ["foo·|", "foo ", 4, { from: 3, to: 4 }],
    ["foo··|", "foo  ", 5, null],
    ["foo···|", "foo   ", 6, null],
    ["foo⇥|", "foo\t", 4, { from: 3, to: 4 }],
    ["foo·⇥|", "foo \t", 5, { from: 3, to: 5 }],
    ["foo⇥··|", "foo\t  ", 6, null],
    ["··|", "  ", 2, null],
    ["foo·|··bar", "foo   bar", 4, { from: 3, to: 6 }],
    ["foo··|bar", "foo  bar", 5, null],
  ] as const)("matches the Enter table for %s", (_label, text, column, run) => {
    expect(trailingRunToTrim(text, column)).toEqual(run);
  });
});

function runCommand(state: EditorState) {
  let nextState = state;
  const transactions: Transaction[] = [];
  const dispatch = vi.fn((spec: TransactionSpec) => {
    const transaction = state.update(spec);
    transactions.push(transaction);
    nextState = transaction.state;
  });
  const handled = trimTrailingSpaceOnEnter({
    state,
    dispatch,
  } as unknown as EditorView);
  return {
    handled,
    dispatch,
    state: nextState,
    transaction: transactions[0],
  };
}

describe("trimTrailingSpaceOnEnter", () => {
  it("does not edit when the syntax tree has not reached the cursor", () => {
    syntaxTreeMock.mockReturnValue(treeAt(3));
    const state = EditorState.create({
      doc: "foo ",
      selection: { anchor: 4 },
    });

    const result = runCommand(state);

    expect(result.handled).toBe(false);
    expect(result.dispatch).not.toHaveBeenCalled();
    expect(result.state.doc.toString()).toBe("foo ");
  });

  it.each(["FencedCode", "HTMLBlock", "HTMLTag"])(
    "does not trim whitespace in a %s code context",
    (name) => {
      // HTML must retain inCodeContext's protection when tag completion is enabled.
      syntaxTreeMock.mockReturnValue(treeAt(4, name));
      const state = EditorState.create({
        doc: "foo ",
        selection: { anchor: 4 },
      });

      const result = runCommand(state);

      expect(result.handled).toBe(false);
      expect(result.dispatch).not.toHaveBeenCalled();
      expect(result.state.doc.toString()).toBe("foo ");
    },
  );

  it("uses the absolute trim start for both indentation inputs", () => {
    const calls: Array<{ pos: number; simulatedBreak: number | null }> = [];
    const state = EditorState.create({
      doc: "foo ",
      selection: { anchor: 4 },
      extensions: [
        indentUnit.of("  "),
        indentService.of((context: IndentContext, pos: number) => {
          calls.push({ pos, simulatedBreak: context.simulatedBreak });
          if (pos === 3) return 2;
          if (pos === 4) return 6;
          return null;
        }),
      ],
    });

    const result = runCommand(state);

    expect(result.handled).toBe(true);
    expect(result.dispatch).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pos).toBe(3);
    expect(calls[0]?.simulatedBreak).toBe(3);
    expect(result.state.doc.toString()).toBe("foo\n  ");
    expect(result.state.selection.main.head).toBe(6);
    expect(result.transaction?.isUserEvent("input")).toBe(true);
    expect(result.transaction?.scrollIntoView).toBe(true);
  });

  it("leaves selections and multiple cursors to the default Enter command", () => {
    const selected = EditorState.create({
      doc: "foo ",
      selection: { anchor: 3, head: 4 },
    });
    const multiple = EditorState.create({
      doc: "foo \nbar ",
      selection: EditorSelection.create([
        EditorSelection.cursor(4),
        EditorSelection.cursor(9),
      ]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });

    expect(runCommand(selected).handled).toBe(false);
    expect(runCommand(multiple).handled).toBe(false);
  });
});
