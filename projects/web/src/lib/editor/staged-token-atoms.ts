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
  stagedUnitGap,
} from "@/lib/staged-tokens.ts";

const chip = Decoration.mark({ class: "cm-staged-token" });

/** A unit — a token and its spaces — for `atomicRanges`; never drawn. */
const unit = Decoration.mark({});

type Sets = { chips: DecorationSet; units: DecorationSet };

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
 * One change, kept whole-unit: an insertion inside a unit moves to its end,
 * a change that covers part of a token grows to cover its whole unit, and
 * one that reaches only a unit's spaces shrinks to leave them — Enter
 * trims the spaces around the caret, and growing that would take the file.
 */
function adjust(
  fromA: number,
  toA: number,
  units: StagedTokenRange[],
): { from: number; to: number } {
  let from = fromA;
  let to = toA;
  for (const u of units) {
    if (from === to) {
      if (u.unitFrom < from && from < u.unitTo) from = to = u.unitTo;
    } else if (from < u.to && to > u.from) {
      if (from > u.unitFrom || to < u.unitTo) {
        from = Math.min(from, u.unitFrom);
        to = Math.max(to, u.unitTo);
      }
    } else if (from < u.unitTo && to > u.unitFrom) {
      if (to <= u.from) to = u.unitFrom;
      else from = u.unitTo;
    }
  }
  return { from, to };
}

/** Whether `from`–`to` is exactly one unit, or several that touch. */
function isUnitRun(
  from: number,
  to: number,
  units: StagedTokenRange[],
): boolean {
  let at = from;
  for (const u of units) {
    if (u.unitFrom < at) continue;
    if (u.unitFrom > at) return false;
    at = u.unitTo;
    if (at === to) return true;
  }
  return false;
}

/**
 * Keep every unit whole against edits that do not move the caret through
 * it — Mod-D selecting `png` inside a token, then typing, for instance — and
 * leave the words around a deleted unit spaced as they read. Undo and redo
 * never come here: history dispatches them with `filter: false`, and
 * replays only what already passed through here.
 */
function wholeTokenFilter(knows: (key: string) => boolean): Extension {
  return EditorState.transactionFilter.of(
    (tr): Transaction | TransactionSpec => {
      if (!tr.docChanged) return tr;
      const text = tr.startState.doc.toString();
      const units = stagedTokenRanges(text, knows);
      if (units.length === 0) return tr;

      const edits: Edit[] = [];
      let changed = false;
      tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
        const { from, to } = adjust(fromA, toA, units);
        if (from !== fromA || to !== toA) changed = true;
        const insert = inserted.toString();
        edits.push({
          from,
          to,
          insert,
          parts: [{ fromB, length: insert.length, offset: 0 }],
        });
      });

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
      // Units deleted and nothing typed: the words on each side may need a
      // space to keep apart. The caret stays on the side it came from, past
      // the space for Backspace and in front of it for Delete.
      const forward = tr.isUserEvent("delete.forward");
      for (const edit of merged) {
        if (edit.insert !== "" || !isUnitRun(edit.from, edit.to, units)) {
          continue;
        }
        const gap = stagedUnitGap(text, edit.from, edit.to);
        if (gap === "") continue;
        edit.insert = gap;
        if (!forward) {
          for (const part of edit.parts) part.offset = gap.length;
        }
        changed = true;
      }
      if (!changed) return tr;

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
 * Staged-file tokens as single units, each token with the spaces on either
 * side of it: a chip behind the token alone, a caret that cannot stop inside
 * a unit (arrow keys, clicks and Backspace/Delete all skip atomic ranges),
 * and a filter for the edits that skip nothing. The caret therefore never
 * rests against a chip, where the browser would compose IME text inside its
 * span and paint the pending text with the chip. `knows` says which keys the
 * editor staged; anything else is text.
 */
export function stagedTokenAtoms(knows: (key: string) => boolean): Extension {
  const decorate = (state: EditorState): Sets => {
    const ranges = stagedTokenRanges(state.doc.toString(), knows);
    return {
      chips: Decoration.set(ranges.map((r) => chip.range(r.from, r.to))),
      units: Decoration.set(
        ranges.map((r) => unit.range(r.unitFrom, r.unitTo)),
      ),
    };
  };

  const chips = ViewPlugin.fromClass(
    class {
      sets: Sets;
      constructor(view: EditorView) {
        this.sets = decorate(view.state);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.sets = decorate(update.state);
      }
    },
    {
      decorations: (plugin) => plugin.sets.chips,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.sets.units ?? Decoration.none,
        ),
    },
  );

  return [chips, chipTheme, wholeTokenFilter(knows)];
}
