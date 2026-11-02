import { isolateHistory } from "@codemirror/commands";
import {
  type AnnotationType,
  type ChangeSet,
  EditorSelection,
  EditorState,
  type Extension,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import {
  type StagedTokenRange,
  stagedTokenRanges,
} from "@/lib/staged-tokens.ts";

const chip = Decoration.mark({ class: "cm-staged-token" });

// A tint of muted-foreground rather than --muted itself: on the editor's
// white, --muted is a 3% grey nobody sees, and the mix follows every palette.
const chipTheme = EditorView.theme({
  ".cm-staged-token": {
    backgroundColor:
      "color-mix(in oklab, var(--muted-foreground) 16%, transparent)",
    borderRadius: "var(--radius-sm)",
  },
});

/** The annotations a rewritten transaction carries over from the original. */
const KEPT_ANNOTATIONS: AnnotationType<unknown>[] = [
  Transaction.userEvent,
  Transaction.addToHistory,
  Transaction.remote,
  isolateHistory,
];

type Edit = {
  from: number;
  to: number;
  insert: string;
  /** Each original change merged into this one: where its text began
   * in the original result, how long it is, and where it sits in `insert`. */
  parts: Array<{ fromB: number; length: number; offset: number }>;
};

/**
 * One change, kept whole-token: an insertion inside a token moves to its
 * end, and a change that covers part of a token grows to cover all of it.
 */
function adjust(
  fromA: number,
  toA: number,
  tokens: StagedTokenRange[],
): { from: number; to: number } {
  let from = fromA;
  let to = toA;
  for (const token of tokens) {
    if (from === to) {
      if (token.from < from && from < token.to) from = to = token.to;
    } else if (
      from < token.to &&
      to > token.from &&
      (from > token.from || to < token.to)
    ) {
      from = Math.min(from, token.from);
      to = Math.max(to, token.to);
    }
  }
  return { from, to };
}

/**
 * Keep every token whole against edits that do not move the caret through
 * it — Mod-D selecting `png` inside one, then typing, for instance. Undo and
 * redo never come here: history dispatches them with `filter: false`, and
 * replays only what already passed through here.
 */
function wholeTokenFilter(knows: (key: string) => boolean): Extension {
  return EditorState.transactionFilter.of(
    (tr): Transaction | TransactionSpec => {
      if (!tr.docChanged) return tr;
      const tokens = stagedTokenRanges(tr.startState.doc.toString(), knows);
      if (tokens.length === 0) return tr;

      const edits: Edit[] = [];
      let changed = false;
      tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
        const { from, to } = adjust(fromA, toA, tokens);
        if (from !== fromA || to !== toA) changed = true;
        const insert = inserted.toString();
        edits.push({
          from,
          to,
          insert,
          parts: [{ fromB, length: insert.length, offset: 0 }],
        });
      });
      if (!changed) return tr;

      edits.sort((a, b) => a.from - b.from);
      const merged: Edit[] = [];
      for (const edit of edits) {
        const last = merged.at(-1);
        if (last !== undefined && edit.from < last.to) {
          const offset = last.insert.length;
          last.to = Math.max(last.to, edit.to);
          last.insert += edit.insert;
          for (const part of edit.parts) {
            last.parts.push({ ...part, offset: part.offset + offset });
          }
        } else {
          merged.push({ ...edit, parts: [...edit.parts] });
        }
      }
      const changes: ChangeSet = tr.startState.changes(
        merged.map(({ from, to, insert }) => ({ from, to, insert })),
      );

      const annotations = KEPT_ANNOTATIONS.flatMap((type) => {
        const value = tr.annotation(type);
        return value === undefined ? [] : [type.of(value)];
      });
      const spec: TransactionSpec = {
        changes,
        effects: tr.effects,
        annotations,
        scrollIntoView: tr.scrollIntoView,
      };
      // Without a selection of its own the transaction maps the old one
      // through the new changes, which is already right.
      if (tr.selection !== undefined) {
        // A position in text a change inserted follows that text to where it
        // now lands; any other one goes back to the old document and forward
        // through the new changes.
        const placed = merged.flatMap((edit) => {
          const start = changes.mapPos(edit.from, -1);
          return edit.parts.map((part) => ({
            ...part,
            at: start + part.offset,
          }));
        });
        const back = tr.changes.invertedDesc;
        const map = (pos: number): number => {
          for (const part of placed) {
            if (part.fromB <= pos && pos <= part.fromB + part.length) {
              return part.at + (pos - part.fromB);
            }
          }
          return changes.mapPos(back.mapPos(pos), 1);
        };
        spec.selection = EditorSelection.create(
          tr.selection.ranges.map((range) =>
            EditorSelection.range(map(range.anchor), map(range.head)),
          ),
          tr.selection.mainIndex,
        );
      }
      return spec;
    },
  );
}

/**
 * Staged-file tokens as single units: a chip behind each, a caret that
 * cannot stop inside one (arrow keys, clicks and Backspace/Delete all skip
 * atomic ranges), and a filter for the edits that skip nothing. `knows`
 * says which keys the editor staged; anything else is text.
 */
export function stagedTokenAtoms(knows: (key: string) => boolean): Extension {
  const decorate = (state: EditorState): DecorationSet =>
    Decoration.set(
      stagedTokenRanges(state.doc.toString(), knows).map((range) =>
        chip.range(range.from, range.to),
      ),
    );

  const chips = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view.state);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = decorate(update.state);
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
        ),
    },
  );

  return [chips, chipTheme, wholeTokenFilter(knows)];
}
