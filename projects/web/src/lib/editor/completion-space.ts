import type { Completion } from "@codemirror/autocomplete";
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Pe/Pf cover closing brackets and quotes. Ambiguous straight quotes are
// deliberately excluded: `@alice's` and `@alice 'quoted'` need opposite rules.
const ATTACHES_LEFT = /^(?:[\p{Pe}\p{Pf}]|[,.;:!?~，。、；：！？～…])$/u;

export function attachesLeft(char: string): boolean {
  return ATTACHES_LEFT.test(char);
}

const setPendingSpace = StateEffect.define<number | null>();

const pendingSpace = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    let effected = false;
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setPendingSpace)) {
        effected = true;
        next = effect.value;
      }
    }
    if (effected) return next;
    if (transaction.docChanged) return null;

    const selection = transaction.state.selection.main;
    return value !== null && selection.empty && selection.head === value + 1
      ? value
      : null;
  },
});

export function pendingSpaceAt(state: EditorState): number | null {
  return state.field(pendingSpace, false) ?? null;
}

export function applyWithSpace(
  text: string,
): Exclude<Completion["apply"], string> {
  return (view, _completion, from, to) => {
    const hasWhitespace = /^[ \t]$/.test(view.state.sliceDoc(to, to + 1));
    const insert = hasWhitespace ? text : `${text} `;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + text.length + 1 },
      effects: hasWhitespace
        ? undefined
        : setPendingSpace.of(from + text.length),
      userEvent: "input.complete",
    });
  };
}

const handlePendingSpace = EditorView.inputHandler.of(
  (view, from, to, text) => {
    // CodeMirror invokes input handlers during composition too. The broader
    // flag also covers compositionstart before the first DOM document change.
    if (view.compositionStarted) return false;

    const at = pendingSpaceAt(view.state);
    if (
      at === null ||
      from !== to ||
      from !== at + 1 ||
      text.length !== 1 ||
      view.state.sliceDoc(at, at + 1) !== " "
    ) {
      return false;
    }

    if (attachesLeft(text)) {
      view.dispatch({
        changes: { from: at, to: at + 1, insert: text },
        selection: { anchor: at + text.length },
        userEvent: "input.type",
      });
      return true;
    }

    if (text === " ") {
      view.dispatch({ effects: setPendingSpace.of(null) });
      return true;
    }

    return false;
  },
);

export const spaceAfterAccept: Extension = [pendingSpace, handlePendingSpace];
