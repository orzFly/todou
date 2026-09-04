import {
  copyLineDown,
  defaultKeymap,
  deleteLine,
  history,
  historyKeymap,
  moveLineDown,
  moveLineUp,
  selectLine,
} from "@codemirror/commands";
import {
  defineLanguageFacet,
  HighlightStyle,
  Language,
  syntaxHighlighting,
} from "@codemirror/language";
import { selectNextOccurrence } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { parser as commonmarkParser, GFM } from "@lezer/markdown";
import { useEffect, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * GFM markdown, assembled straight from the Lezer parser rather than through
 * @codemirror/lang-markdown. That package hard-depends on lang-html — and so
 * on the JS and CSS parsers and @codemirror/autocomplete — purely to colour
 * embedded HTML in fenced blocks. It costs ~170 KB gzip, which is more than
 * the rest of the editor put together, to highlight something a comment box
 * has no use for.
 */
const markdownLanguage = new Language(
  defineLanguageFacet({
    commentTokens: { block: { open: "<!--", close: "-->" } },
  }),
  commonmarkParser.configure([GFM]),
  [],
  "markdown",
);

export type MarkdownEditorHandle = {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
};

/**
 * Native-event shape shared by React's synthetic events and the DOM's own —
 * the staging handlers in issue/staged-files.tsx are written against this so
 * one hook serves both a <textarea> and CodeMirror's raw listeners.
 */
export type FileClipboardEvent = {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
};
export type FileDragEvent = {
  dataTransfer: DataTransfer | null;
  preventDefault: () => void;
};

export type MarkdownEditorProps = {
  /** Read once, at mount: the editor owns its document from then on. */
  initialValue?: string;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  /** Mod-Enter. Receives the current document so callers need no ref. */
  onSubmit?: (value: string) => void;
  /** Escape. */
  onCancel?: () => void;
  /**
   * Fires on every document change. Only for cheap derived state (an empty
   * draft disabling its submit button) — the document itself lives in the
   * editor, not in React.
   */
  onChange?: (value: string) => void;
  onPaste?: (event: FileClipboardEvent) => void;
  onDrop?: (event: FileDragEvent) => void;
  onDragOver?: (event: FileDragEvent) => void;
  /** Extra CodeMirror extensions, appended last so they can override. */
  extensions?: Extension;
  /** Height is the caller's business: pass the min-height/max-height here. */
  className?: string;
  ref?: React.Ref<MarkdownEditorHandle>;
};

/** Sublime-style line editing, the six bindings redline settles on. */
const lineKeymap = [
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
  { key: "Mod-l", run: selectLine },
  { key: "Mod-Shift-k", run: deleteLine },
  { key: "Mod-Shift-d", run: copyLineDown },
  { key: "Alt-ArrowUp", run: moveLineUp },
  { key: "Alt-ArrowDown", run: moveLineDown },
];

/**
 * Restrained markdown highlighting: enough structure to see the shape of a
 * comment, never a rainbow. Colors come from theme variables only, so every
 * palette — and .dark — follows without a rebuild.
 */
const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--primary)" },
  {
    tag: [tags.monospace, tags.labelName],
    fontFamily: "var(--font-mono)",
    color: "var(--foreground)",
  },
  { tag: tags.quote, color: "var(--muted-foreground)" },
  // The literal `#`, `*`, backticks — present but receding.
  {
    tag: [tags.processingInstruction, tags.contentSeparator],
    color: "var(--muted-foreground)",
  },
]);

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
 * The one markdown input surface for the whole app: comments, issue bodies,
 * spec annotations and question answers all mount this.
 *
 * The document is deliberately *not* React state — the EditorView owns it and
 * callers read through the ref at submit time. onChange exists only for
 * derived flags; routing every keystroke through React would re-render the
 * timeline on every character.
 */
export function MarkdownEditor({
  initialValue = "",
  placeholder = "",
  ariaLabel,
  autoFocus = false,
  readOnly = false,
  onSubmit,
  onCancel,
  onChange,
  onPaste,
  onDrop,
  onDragOver,
  extensions,
  className,
  ref,
}: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Keymap and DOM handlers are built once but must always call today's
  // props, not the ones captured at mount.
  const handlers = useRef({
    onSubmit,
    onCancel,
    onChange,
    onPaste,
    onDrop,
    onDragOver,
  });
  handlers.current = {
    onSubmit,
    onCancel,
    onChange,
    onPaste,
    onDrop,
    onDragOver,
  };
  // One compartment per mutable extension, so a prop change reconfigures
  // that slice instead of rebuilding the view (and losing undo history).
  const placeholderSlot = useRef(new Compartment()).current;
  const readOnlySlot = useRef(new Compartment()).current;
  const extensionsSlot = useRef(new Compartment()).current;

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
            {
              key: "Mod-Enter",
              run: (v) => {
                const submit = handlers.current.onSubmit;
                if (submit === undefined) return false;
                submit(v.state.doc.toString());
                return true;
              },
            },
            {
              key: "Escape",
              run: () => {
                const cancel = handlers.current.onCancel;
                if (cancel === undefined) return false;
                cancel();
                return true;
              },
            },
            ...lineKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdownLanguage.extension,
          syntaxHighlighting(highlightStyle),
          editorTheme,
          EditorView.contentAttributes.of({
            // CodeMirror's contenteditable opts out of the niceties a
            // <textarea> gets for free.
            spellcheck: "true",
            autocapitalize: "sentences",
            autocorrect: "on",
            ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
          }),
          EditorView.domEventHandlers({
            paste: (event) => {
              handlers.current.onPaste?.(event);
              return false;
            },
            drop: (event) => {
              handlers.current.onDrop?.(event);
              return false;
            },
            dragover: (event) => {
              handlers.current.onDragOver?.(event);
              return false;
            },
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
    if (autoFocus) instance.focus();
    return () => {
      instance.destroy();
      view.current = null;
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
      data-slot="markdown-editor"
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
