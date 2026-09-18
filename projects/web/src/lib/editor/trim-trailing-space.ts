import {
  getIndentation,
  IndentContext,
  indentString,
  syntaxTree,
} from "@codemirror/language";
import { countColumn } from "@codemirror/state";
import type { Command } from "@codemirror/view";

import { inCodeContext } from "@/lib/editor/code-context.ts";

/**
 * The whitespace Enter should replace along with the line break; null means
 * defer to the default command.
 */
export function trailingRunToTrim(
  text: string,
  column: number,
): { from: number; to: number } | null {
  if (column === 0 || !/[ \t]/.test(text[column - 1] ?? "")) return null;
  if (/^[ \t]*$/.test(text.slice(0, column))) return null;
  if (column >= 2 && text[column - 1] === " " && text[column - 2] === " ") {
    return null;
  }

  let from = column;
  while (from > 0 && /[ \t]/.test(text[from - 1] ?? "")) from -= 1;
  let to = column;
  while (to < text.length && /[ \t]/.test(text[to] ?? "")) to += 1;
  return { from, to };
}

/**
 * Trim a disposable trailing run and insert the newline in one transaction,
 * so one key press remains one undo step.
 */
export const trimTrailingSpaceOnEnter: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) {
    return false;
  }

  const { head } = state.selection.main;
  const line = state.doc.lineAt(head);
  const run = trailingRunToTrim(line.text, head - line.from);
  if (run === null) return false;

  const tree = syntaxTree(state);
  // Parsing is lazy. If it has not reached the cursor, code context is
  // unknown and deleting bytes would be unsafe.
  if (tree.length < head || inCodeContext(tree, head)) return false;

  const from = line.from + run.from;
  const to = line.from + run.to;
  const columns =
    getIndentation(new IndentContext(state, { simulateBreak: from }), from) ??
    countColumn(/^\s*/.exec(line.text)?.[0] ?? "", state.tabSize);
  const indent = indentString(state, columns);

  view.dispatch({
    changes: { from, to, insert: `\n${indent}` },
    selection: { anchor: from + 1 + indent.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};
