import type { ChangeSpec, Line, StateCommand } from "@codemirror/state";

import { QUOTED_LINE } from "@/lib/quote-markdown.ts";

/**
 * Mod-Shift-. — quote or unquote every line a selection touches, all cursors
 * at once. Unquoting needs every non-blank line already quoted; one plain
 * line among them means the reader is extending the quote, so everything
 * gains a level instead.
 */
export const toggleQuote: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const lines = new Map<number, Line>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    let last = state.doc.lineAt(range.to);
    // A selection dragged to the start of the next line has not chosen it.
    if (!range.empty && range.to === last.from && last.number > first.number) {
      last = state.doc.line(last.number - 1);
    }
    for (let n = first.number; n <= last.number; n++) {
      lines.set(n, state.doc.line(n));
    }
  }
  const ordered = [...lines.values()].sort((a, b) => a.number - b.number);
  const unquoting =
    ordered.every(
      (line) => line.text.trim() === "" || QUOTED_LINE.test(line.text),
    ) && ordered.some((line) => line.text.trim() !== "");

  const changes: ChangeSpec[] = [];
  for (const line of ordered) {
    if (unquoting) {
      const marker = /^( {0,3})> ?/.exec(line.text);
      if (marker === null) continue;
      const lead = marker[1]?.length ?? 0;
      changes.push({
        from: line.from + lead,
        to: line.from + marker[0].length,
      });
    } else if (line.text.trim() === "") {
      changes.push({ from: line.from, to: line.to, insert: ">" });
    } else {
      changes.push({ from: line.from, insert: "> " });
    }
  }
  const changeSet = state.changes(changes);
  dispatch(
    state.update({
      changes: changeSet,
      selection: state.selection.map(changeSet, 1),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};
