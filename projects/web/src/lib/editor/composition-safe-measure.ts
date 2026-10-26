import { type EditorView, ViewPlugin } from "@codemirror/view";

type TextSize = { lineHeight: number; charWidth: number; textHeight: number };

/** The slice of @codemirror/view's private DocView this module touches. */
type DocView = { view: EditorView; measureTextSize(): TextSize };

const installed = Symbol("todou.compositionSafeMeasure");

/**
 * Wrap DocView.prototype.measureTextSize once, for every editor in the app.
 * Reports whether a DocView was there to find: the plugin is constructed
 * before the view builds its first one.
 */
function install(view: EditorView): boolean {
  const docView = (view as unknown as { docView?: DocView }).docView;
  if (docView === undefined) return false;
  const proto = Object.getPrototypeOf(docView) as DocView & {
    [installed]?: true;
  };
  if (proto[installed]) return true;
  proto[installed] = true;
  const original = proto.measureTextSize;
  // Fail open: a CodeMirror that has moved this method keeps its own
  // behaviour, which only costs the iOS bug below.
  if (typeof original !== "function") return true;
  proto.measureTextSize = function (this: DocView): TextSize {
    // A zero line height makes the only caller skip this refresh; the
    // update that ends the composition measures again.
    if (this.view.compositionStarted) {
      return { lineHeight: 0, charWidth: 0, textHeight: 0 };
    }
    return original.call(this);
  };
  return true;
}

/**
 * Keep CodeMirror from measuring text size mid-composition (T-583).
 *
 * When no line is short and ASCII-only enough to measure in place — any
 * CJK draft — measureTextSize appends a dummy line to the contenteditable
 * and removes it again. It runs whenever line heights stop matching the
 * estimate, so a composition that flips the last line's wrap triggers it,
 * and iOS pinyin flips it on every key of an English word typed near a line
 * end. iOS WebKit loses track of the marked text across that mutation: the
 * IME's next replacement lands at the wrong offset, and stray letters or the
 * spaced pinyin itself end up in the document.
 *
 * This reaches into a private class rather than carrying a pnpm patch of
 * @codemirror/view, so the editor package can ship it.
 */
export const compositionSafeMeasure = ViewPlugin.define((view) => {
  let done = install(view);
  return {
    update(update) {
      if (!done) done = install(update.view);
    },
  };
});
