import {
  copyLineDown,
  deleteLine,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  selectLine,
} from "@codemirror/commands";
import {
  defineLanguageFacet,
  HighlightStyle,
  Language,
} from "@codemirror/language";
import { selectNextOccurrence } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { dropCursor, EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { parser as commonmarkParser, GFM } from "@lezer/markdown";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  CodeEditor,
  type CodeEditorHandle,
} from "@/components/shared/code-editor.tsx";
import { handlePaste, pasteAs } from "@/lib/editor/paste-as.ts";
import { toggleQuote } from "@/lib/editor/quote-toggle.ts";
import { stagedTokenAtoms } from "@/lib/editor/staged-token-atoms.ts";
import { trimTrailingSpaceOnEnter } from "@/lib/editor/trim-trailing-space.ts";
import { prefetchPasteConverter } from "@/lib/paste/load.ts";
import { STAGED_TOKEN_TYPE } from "@/lib/staged-tokens.ts";

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

export type MarkdownEditorHandle = CodeEditorHandle;

/**
 * Where pasted, dropped and picked files go: `useStagedFiles` in
 * issue/staged-files.tsx implements it, and the editor only calls it. Each
 * staged file sits in the text as a token, which the editor keeps whole.
 */
export type EditorFileStaging = {
  /** The view once mounted, null once it is gone. */
  bind: (view: EditorView | null) => void;
  /** Every document change, programmatic ones included. */
  sync: (doc: string) => void;
  /** Whether `key` is a file this editor staged: only those are tokens. */
  knows: (key: number) => boolean;
  /** Takes the paste's files, if any, and then default-prevents it. */
  paste: (event: ClipboardEvent, view: EditorView) => void;
  /** True when it took the drop's files; CodeMirror's own drop then stays out. */
  drop: (event: DragEvent, view: EditorView) => boolean;
  dragOver: (event: DragEvent) => void;
};

/** One instance for every editor, so reconfiguring never rebuilds it. */
const dropCursorExtension = dropCursor();

export type MarkdownEditorProps = {
  /** Read once, at mount: the editor owns its document from then on. */
  initialValue?: string;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  /** Dirty state is registered by a stable owner outside this editor. */
  ownerManagedDirty?: boolean;
  /**
   * Mod-Enter. Receives the current document so callers need no ref.
   *
   * Mod-Enter belongs to this prop alone: without one the key does nothing,
   * and a blank line goes on Alt-Enter instead. Callers that submit another
   * way leave Alt-Enter to the editor.
   */
  onSubmit?: (value: string) => void;
  /** Escape. */
  onCancel?: () => void;
  /**
   * Fires on every document change. Only for cheap derived state (an empty
   * draft disabling its submit button) — the document itself lives in the
   * editor, not in React.
   */
  onChange?: (value: string) => void;
  /**
   * File staging. Read at mount for the token extension, which is installed
   * only for an editor that had it then.
   */
  staging?: EditorFileStaging;
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
  // Where Mod-Enter used to land: @codemirror/commands' defaultKeymap binds
  // Mod-Enter to insertBlankLine, and this editor now claims that key for
  // submit, so the blank line needs a binding of its own.
  { key: "Alt-Enter", run: insertBlankLine },
];

/**
 * CodeMirror matches Shift+. by keyCode as `Mod-Shift-.`, but a layout whose
 * Shift+. is `>` can arrive under that name instead.
 */
const quoteKeymap = [
  { key: "Mod-Shift-.", run: toggleQuote },
  { key: "Mod->", run: toggleQuote },
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

/**
 * The one markdown input surface for the whole app: comments, issue bodies,
 * spec annotations and question answers all mount this.
 *
 * The document is deliberately *not* React state — the EditorView owns it and
 * callers read through the ref at submit time. onChange exists only for
 * derived flags; routing every keystroke through React would re-render the
 * timeline on every character.
 */
export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function MarkdownEditor(
  {
    initialValue,
    placeholder,
    ariaLabel,
    autoFocus,
    readOnly,
    ownerManagedDirty,
    onSubmit,
    onCancel,
    onChange,
    staging,
    extensions,
    className,
  },
  ref,
) {
  // Keymap and DOM handlers are built once but must always call today's
  // props, not the ones captured at mount.
  const handlers = useRef({ onSubmit, onCancel, staging });
  handlers.current = { onSubmit, onCancel, staging };
  useImperativeHandle(ref, () => innerRef.current as MarkdownEditorHandle, []);

  const innerRef = useRef<CodeEditorHandle | null>(null);

  // Built once, like the handlers: a new instance would make the compartment
  // rebuild the chips on every render.
  const [tokenExtension] = useState(() =>
    staging === undefined
      ? []
      : stagedTokenAtoms(
          (key) => handlers.current.staging?.knows(key) ?? false,
        ),
  );
  const bindView = useCallback(
    (view: EditorView | null) => handlers.current.staging?.bind(view),
    [],
  );

  useEffect(() => {
    const prefetch = () => void prefetchPasteConverter().catch(() => {});
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(prefetch);
      return () => cancelIdleCallback(handle);
    }
    const handle = setTimeout(prefetch, 0);
    return () => clearTimeout(handle);
  }, []);

  return (
    <CodeEditor
      slot="markdown-editor"
      ref={innerRef}
      initialValue={initialValue}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      autoFocus={autoFocus}
      readOnly={readOnly}
      ownerManagedDirty={ownerManagedDirty}
      keymap={[
        {
          key: "Mod-Enter",
          run: (v) => {
            // Swallowed whether or not anyone is listening. Falling
            // through would reach defaultKeymap's Mod-Enter →
            // insertBlankLine, and a key that means "submit" everywhere
            // else in the app should not silently add a line here.
            handlers.current.onSubmit?.(v.state.doc.toString());
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
        // Completion's Prec.highest keymap sees Enter first while its panel is
        // open; this only handles the key after completion declines it.
        {
          key: "Enter",
          run: trimTrailingSpaceOnEnter,
          shift: trimTrailingSpaceOnEnter,
        },
        ...lineKeymap,
        ...quoteKeymap,
      ]}
      language={markdownLanguage}
      highlightStyle={highlightStyle}
      onView={bindView}
      onChange={(value) => {
        handlers.current.staging?.sync(value);
        onChange?.(value);
      }}
      extensions={[
        pasteAs(),
        dropCursorExtension,
        tokenExtension,
        EditorView.domEventHandlers({
          // Staged files first: a paste they take as files is
          // default-prevented, and handlePaste then leaves it alone. Both
          // live in this one handler because the order of two separate
          // handlers is decided by extension precedence, not by position.
          paste: (event, view) => {
            handlers.current.staging?.paste(event, view);
            return handlePaste(view, event);
          },
          drop: (event, view) => {
            const staging = handlers.current.staging;
            if (staging !== undefined) return staging.drop(event, view);
            // A tray's token means nothing to an editor that stages no files.
            if (event.dataTransfer?.types.includes(STAGED_TOKEN_TYPE)) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          dragover: (event) => {
            handlers.current.staging?.dragOver(event);
            return false;
          },
        }),
        ...(extensions ? [extensions] : []),
      ]}
      className={className}
    />
  );
});
