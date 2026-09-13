import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { type HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef } from "react";

import { useDirtySource } from "@/lib/unsaved-guard.ts";
import { cn } from "@/lib/utils";

export type CodeEditorHandle = {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
  /**
   * Close an open completion panel, reporting whether there was one. An
   * editor inside a dismissable layer needs this because that layer listens
   * for Escape on the document in the capture phase and calls
   * `preventDefault` — after which CodeMirror's own handlers decline the
   * event, so the layer's owner has to do the closing.
   */
  dismissCompletion: () => boolean;
};

export type CodeEditorProps = {
  /** Read once, at mount: the editor owns its document from then on. */
  initialValue?: string;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  /**
   * Caller's own key bindings, placed ahead of the base keymap. The order is
   * load-bearing: defaultKeymap binds Mod-Enter to insertBlankLine, so a
   * submit binding listed after it never fires.
   */
  keymap?: KeyBinding[];
  /** Language support, e.g. a markdown Language or a StreamLanguage. */
  language?: Extension;
  /** Token-level colouring to pair with `language`. */
  highlightStyle?: HighlightStyle;
  /**
   * Fires on every document change. Only for cheap derived state (an empty
   * draft disabling its submit button) — the document itself lives in the
   * editor, not in React.
   */
  onChange?: (value: string) => void;
  /** Extra CodeMirror extensions, appended last so they can override. */
  extensions?: Extension;
  /**
   * data-slot of the host element. Tests reach a specific editor kind
   * through it; the default names the generic shell.
   */
  slot?: string;
  /** Height is the caller's business: pass the min-height/max-height here. */
  className?: string;
  /** The underlying EditorView, once mounted — for callers that drive the
   * cursor programmatically (jump-to-row, snippet insertion). */
  onView?: (view: EditorView | null) => void;
  ref?: React.Ref<CodeEditorHandle>;
};

/** Mirrors ui/textarea.tsx's look, with every colour coming from a variable. */
const editorTheme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontFamily: "var(--font-sans)",
    // style-mod cannot express a media query against the generated theme
    // class, so the breakpoint lives in the wrapper's Tailwind classes and
    // the editor simply inherits it.
    fontSize: "inherit",
    // Lets the wrapper's max-height clamp the editor so .cm-scroller,
    // not the page, does the scrolling.
    flex: "1 1 auto",
    minHeight: "0",
  },
  "&.cm-focused": { outline: "none" },
  /**
   * alignSelf and minHeight here, with flexGrow on .cm-scroller below, are what
   * makes the blank area under a short document part of the editor rather than
   * a dead shell. The base theme already means to do that, with
   * `.cm-scroller { height: 100% }` and `.cm-content { min-height: 100% }` —
   * but callers give this component a min-height, never a height, so the
   * containing block is never definite, both percentages silently resolve to
   * `auto`, and the contenteditable stays as short as its text. None of the
   * three below depends on percentage resolution: the scroller takes the
   * leftover height through flex, align-self overrides the base theme's
   * `align-items: flex-start !important` so the content stretches down the
   * cross axis, and min-content floors that stretch — a stretched box is
   * clamped to the flex line, which costs a document taller than the caller's
   * max-height its bottom padding, with no way to scroll to it.
   */
  ".cm-content": {
    padding: "0.5rem 0.625rem",
    lineHeight: "1.5",
    caretColor: "var(--foreground)",
    alignSelf: "stretch",
    minHeight: "min-content",
  },
  // CodeMirror's own base theme puts monospace here; this is a comment box,
  // not a code box.
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    // Not `flex: 1`, which would zero the basis; the other two components of
    // the shorthand are already at their defaults.
    flexGrow: "1",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
    },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-gutters": { display: "none" },
});

/**
 * The common CodeMirror shell for every editor in the app: mounting, the
 * placeholder/readOnly/extensions compartments, the theme, dirty tracking,
 * and the base key bindings. Callers bring their own language and, ahead of
 * the base keymap, their own semantics — submit keys, line editing, snippets.
 */
export function CodeEditor({
  initialValue = "",
  placeholder = "",
  ariaLabel,
  autoFocus = false,
  readOnly = false,
  keymap: callerKeymap,
  language,
  highlightStyle,
  onChange,
  extensions,
  slot,
  onView,
  className,
  ref,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Compared against, never written: a ref outlives the mount effect below,
  // so the box stays "edited from what it was opened with" even after
  // Suspense rebuilds the document — which is also why the baseline cannot
  // come from the EditorView, whose doc may already be the rebuilt one.
  const baseline = useRef(initialValue);
  // Keymap and DOM handlers are built once but must always call today's
  // props, not the ones captured at mount.
  const handlers = useRef({ onChange });
  handlers.current = { onChange };
  // One compartment per mutable extension, so a prop change reconfigures
  // that slice instead of rebuilding the view (and losing undo history).
  const placeholderSlot = useRef(new Compartment()).current;
  const readOnlySlot = useRef(new Compartment()).current;
  const extensionsSlot = useRef(new Compartment()).current;

  // Read through the ref rather than the closure: the EditorView is a
  // different instance after a rebuild, and only the baseline has to survive
  // that. Whitespace-only differences are not worth a confirmation.
  useDirtySource(
    () =>
      !readOnly &&
      (view.current?.state.doc.toString() ?? baseline.current).trim() !==
        baseline.current.trim(),
  );

  useImperativeHandle(ref, () => ({
    getValue: () => view.current?.state.doc.toString() ?? "",
    setValue: (value: string) => {
      const current = view.current;
      if (!current) return;
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
      });
    },
    focus: () => view.current?.focus(),
    dismissCompletion: () => {
      const current = view.current;
      // "pending" is a query in flight with nothing on screen yet, which is
      // not something the reader can have meant to dismiss.
      if (current === null || completionStatus(current.state) !== "active") {
        return false;
      }
      closeCompletion(current);
      return true;
    },
  }));

  // Mount once. initialValue/ariaLabel changes do not rebuild the view —
  // remount with a new `key` if a caller ever needs that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by design; every mutable prop is reconfigured through the compartments below.
  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const instance = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          drawSelection(),
          // Without this CM silently collapses every extra range, which is
          // what makes Mod-D look like a no-op.
          EditorState.allowMultipleSelections.of(true),
          EditorView.lineWrapping,
          keymap.of([
            ...(callerKeymap ?? []),
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          ...(language ? [language] : []),
          ...(highlightStyle ? [syntaxHighlighting(highlightStyle)] : []),
          editorTheme,
          EditorView.contentAttributes.of({
            // CodeMirror's contenteditable opts out of the niceties a
            // <textarea> gets for free.
            spellcheck: "true",
            autocapitalize: "sentences",
            autocorrect: "on",
            ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              handlers.current.onChange?.(update.state.doc.toString());
            }
          }),
          placeholderSlot.of(placeholderExt(placeholder)),
          readOnlySlot.of(EditorState.readOnly.of(readOnly)),
          extensionsSlot.of(extensions ?? []),
        ],
      }),
    });
    view.current = instance;
    onView?.(instance);
    if (autoFocus) instance.focus();
    return () => {
      instance.destroy();
      view.current = null;
      onView?.(null);
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: placeholderSlot.reconfigure(placeholderExt(placeholder)),
    });
  }, [placeholder, placeholderSlot]);

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlySlot.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, readOnlySlot]);

  useEffect(() => {
    view.current?.dispatch({
      effects: extensionsSlot.reconfigure(extensions ?? []),
    });
  }, [extensions, extensionsSlot]);

  return (
    <div
      ref={host}
      data-slot={slot ?? "code-editor"}
      data-read-only={readOnly ? "true" : undefined}
      className={cn(
        // text-base below md is not cosmetic: iOS auto-zooms a focused field
        // under 16px. Same rule ui/textarea.tsx follows.
        "flex w-full flex-col overflow-hidden rounded-lg border border-input bg-transparent text-base transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 md:text-sm dark:bg-input/30",
        readOnly && "opacity-50",
        className,
      )}
    />
  );
}
