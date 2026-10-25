import { isolateHistory } from "@codemirror/commands";
import {
  type EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  showTooltip,
  type Tooltip,
  type TooltipView,
  ViewPlugin,
} from "@codemirror/view";
import { toast } from "sonner";

import type { PasteSource } from "@/lib/paste/html-to-markdown.ts";
import { pasteConverter } from "@/lib/paste/load.ts";
import { modKeyLabels } from "@/lib/platform.ts";
import { blockquote } from "@/lib/quote-markdown.ts";

type Form = "plain" | "markdown";

/** One paste, in every form the toolbar can turn it into. */
type Pasted = {
  plain: string;
  markdown: string | null;
  inline: boolean;
  form: Form;
  quote: boolean;
};

/** The last paste, while its toolbar can still rewrite it. */
type Live = Pasted & {
  /** The whole insertion, block spacing included. */
  from: number;
  to: number;
  /** Where the pasted text itself ends: the caret, and the toolbar's anchor. */
  end: number;
};

type Intent = { plain: boolean; quote: boolean; at: number };

/**
 * A key that announces the paste after it (Mod-Shift-V) only counts for the
 * paste event that follows straight away; one the browser never fired must
 * not leak into a later, ordinary paste.
 */
const INTENT_TTL_MS = 1000;

const setLive = StateEffect.define<Live | null>();

const liveField = StateField.define<Live | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLive)) return effect.value;
    }
    if (value === null) return null;
    // Typing, undo, a remote rewrite: the range no longer holds what the
    // toolbar would replace.
    if (tr.docChanged) return null;
    if (tr.selection) {
      const { from, to } = tr.selection.main;
      if (from < value.from || to > value.to) return null;
    }
    return value;
  },
  provide: (field) =>
    showTooltip.from(field, (live) =>
      live === null ? null : toolbarTooltip(live),
    ),
});

function hasOptions(pasted: Pasted): boolean {
  return pasted.markdown !== null || pasted.plain.includes("\n");
}

/** The text a form inserts, and whether it is a block that needs air. */
function render(pasted: Pasted): { text: string; block: boolean } {
  const markdown = pasted.form === "markdown" ? pasted.markdown : null;
  const base = markdown ?? pasted.plain;
  if (pasted.quote) return { text: blockquote(base), block: true };
  return { text: base, block: markdown !== null && !pasted.inline };
}

/**
 * Blank lines around a block, so it neither runs on from the paragraph before
 * it nor swallows the one after: a line straight after a quote or a list
 * item is a lazy continuation of it.
 */
function spacing(doc: Text, from: number, to: number) {
  const startLine = doc.lineAt(from);
  const before = doc.sliceString(startLine.from, from);
  let prefix = "";
  if (before.trim() !== "") prefix = "\n\n";
  else if (
    from === startLine.from &&
    startLine.number > 1 &&
    doc.line(startLine.number - 1).text.trim() !== ""
  ) {
    prefix = "\n";
  }
  const endLine = doc.lineAt(to);
  const after = doc.sliceString(to, endLine.to);
  let suffix = "";
  if (after.trim() !== "") suffix = "\n\n";
  else if (
    endLine.number < doc.lines &&
    doc.line(endLine.number + 1).text.trim() !== ""
  ) {
    suffix = "\n";
  }
  return { prefix, suffix };
}

/** Replace [from, to) with `pasted` in its current form, toolbar and all. */
function write(state: EditorState, from: number, to: number, pasted: Pasted) {
  const { text, block } = render(pasted);
  const { prefix, suffix } = block
    ? spacing(state.doc, from, to)
    : { prefix: "", suffix: "" };
  const insert = prefix + text + suffix;
  const length = state.toText(insert).length;
  const end = from + length - suffix.length;
  const live: Live | null = hasOptions(pasted)
    ? { ...pasted, from, to: from + length, end }
    : null;
  return state.update({
    changes: { from, to, insert },
    selection: { anchor: end },
    scrollIntoView: true,
    userEvent: "input.paste",
    // Each form the reader tries is its own undo step, and so is the paste
    // that came before them.
    annotations: isolateHistory.of("full"),
    effects: setLive.of(live),
  });
}

class PasteState {
  intent: Intent | null = null;
  /** The clipboard read a Mod-Alt-V started, until something settles it. */
  reading: object | null = null;

  takeIntent(): Intent | null {
    const intent = this.intent;
    this.intent = null;
    if (intent === null || Date.now() - intent.at > INTENT_TTL_MS) return null;
    return intent;
  }
}

const pasteState = ViewPlugin.define(() => new PasteState());

function textOf(html: string): string {
  return (
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
  );
}

function insertPaste(
  view: EditorView,
  source: PasteSource,
  intent: Intent | null,
): boolean {
  const converter = pasteConverter();
  const conversion =
    converter === null || source.html === ""
      ? null
      : converter.htmlToMarkdown(source);
  const plain =
    source.plain === "" && source.html !== ""
      ? textOf(source.html)
      : source.plain;
  if (plain === "" && (conversion?.markdown ?? null) === null) return false;
  const markdown = conversion?.markdown ?? null;
  const pasted: Pasted = {
    plain,
    markdown,
    inline: conversion?.inline ?? !plain.trim().includes("\n"),
    form:
      intent?.plain || markdown === null || conversion?.codeLike
        ? "plain"
        : "markdown",
    quote: intent?.quote ?? false,
  };
  const { state } = view;
  if (state.selection.ranges.length > 1) {
    // Several cursors get the same text each, without spacing or toolbar —
    // there is no single range for either to be about.
    view.dispatch(
      state.update(state.replaceSelection(render(pasted).text), {
        scrollIntoView: true,
        userEvent: "input.paste",
      }),
    );
    return true;
  }
  const { from, to } = state.selection.main;
  view.dispatch(write(state, from, to, pasted));
  return true;
}

/**
 * The editor's paste, for MarkdownEditor's one paste handler to call once
 * the staged-files handler has had its turn. A paste that handler took as
 * files is already default-prevented, and is left alone.
 */
export function handlePaste(view: EditorView, event: ClipboardEvent): boolean {
  const state = view.plugin(pasteState);
  const intent = state?.takeIntent() ?? null;
  if (event.defaultPrevented || view.state.readOnly) return false;
  const data = event.clipboardData;
  if (data === null) return false;
  const types = [...data.types];
  const source: PasteSource = {
    plain: data.getData("text/plain"),
    html: data.getData("text/html"),
    types,
    ...(types.includes("vscode-editor-data")
      ? { vscodeEditorData: data.getData("vscode-editor-data") }
      : {}),
  };
  if (source.plain === "" && source.html === "") return false;
  // A native paste that beat Mod-Alt-V's own clipboard read wins: macOS
  // also binds ⌥⇧⌘V to its Paste and Match Style menu item.
  if (state !== null) state.reading = null;
  if (!insertPaste(view, source, intent)) return false;
  event.preventDefault();
  return true;
}

async function readClipboard(): Promise<PasteSource> {
  const clipboard = navigator.clipboard;
  if (typeof clipboard?.read !== "function") {
    return { plain: await clipboard.readText(), html: "", types: [] };
  }
  const items = await clipboard.read();
  let plain = "";
  let html = "";
  const types: string[] = [];
  for (const item of items) {
    types.push(...item.types);
    if (plain === "" && item.types.includes("text/plain")) {
      plain = await (await item.getType("text/plain")).text();
    }
    if (html === "" && item.types.includes("text/html")) {
      html = await (await item.getType("text/html")).text();
    }
  }
  return { plain, html, types };
}

/**
 * Mod-Alt-V never raises a paste event (no browser maps it to one), so the
 * clipboard has to be read by hand — which the browser may refuse.
 */
function pasteAsQuote(plain: boolean) {
  return (view: EditorView): boolean => {
    const state = view.plugin(pasteState);
    if (state === null || view.state.readOnly) return false;
    const intent: Intent = { plain, quote: true, at: Date.now() };
    state.intent = intent;
    const token = {};
    state.reading = token;
    readClipboard().then(
      (source) => {
        if (state.reading !== token) return;
        state.reading = null;
        state.intent = null;
        insertPaste(view, source, intent);
      },
      () => {
        if (state.reading !== token) return;
        state.reading = null;
        state.intent = null;
        toast.error(
          `Can't read the clipboard here — paste with ${modKeyLabels().mod}+V, then pick Quote`,
        );
      },
    );
    return true;
  };
}

function rewrite(view: EditorView, change: Partial<Pasted>) {
  const live = view.state.field(liveField, false);
  if (live === null || live === undefined) return;
  view.dispatch(write(view.state, live.from, live.to, { ...live, ...change }));
}

function dismiss(view: EditorView) {
  // Focus moves arrive in the middle of DOM work CodeMirror may itself be
  // doing; dispatching from inside it would throw.
  queueMicrotask(() => {
    if (view.state.field(liveField, false)) {
      view.dispatch({ effects: setLive.of(null) });
    }
  });
}

function toolbarOf(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(".cm-paste-options");
}

function returnToEditor(view: EditorView) {
  const live = view.state.field(liveField, false);
  view.focus();
  if (live) view.dispatch({ selection: { anchor: live.end } });
}

/** Mod-. — into the toolbar, onto the button that is currently on. */
function focusToolbar(view: EditorView): boolean {
  const toolbar = toolbarOf(view);
  if (toolbar === null) return false;
  const current =
    toolbar.querySelector<HTMLElement>('[data-form][aria-pressed="true"]') ??
    toolbar.querySelector<HTMLElement>("button");
  current?.focus();
  return true;
}

function toolbarTooltip(live: Live): Tooltip {
  return { pos: live.end, above: false, create: createToolbar };
}

function createToolbar(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-paste-options";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Paste options");

  const button = (label: string) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.tabIndex = -1;
    return element;
  };
  const plain = button("Plain text");
  plain.dataset.form = "plain";
  const markdown = button("Markdown");
  markdown.dataset.form = "markdown";
  const forms = document.createElement("div");
  forms.className = "cm-paste-forms";
  forms.append(plain, markdown);
  const quote = button("Quote");
  quote.dataset.quote = "";
  dom.append(forms, quote);

  const buttons = () =>
    [...dom.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => !b.hidden,
    );

  const sync = () => {
    const live = view.state.field(liveField, false);
    if (!live) return;
    forms.hidden = live.markdown === null;
    plain.hidden = forms.hidden;
    markdown.hidden = forms.hidden;
    plain.setAttribute("aria-pressed", String(live.form === "plain"));
    markdown.setAttribute("aria-pressed", String(live.form === "markdown"));
    quote.setAttribute("aria-pressed", String(live.quote));
    // One tab stop for the whole toolbar, as a toolbar is meant to have.
    const visible = buttons();
    const active =
      visible.find((b) => b.dataset.form === live.form) ?? visible[0];
    for (const b of visible) b.tabIndex = b === active ? 0 : -1;
  };

  // The editor keeps focus (and its caret) while the mouse is used.
  dom.addEventListener("mousedown", (event) => event.preventDefault());
  dom.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest("button");
    if (target === null) return;
    const live = view.state.field(liveField, false);
    if (!live) return;
    if (target.dataset.form !== undefined) {
      rewrite(view, { form: target.dataset.form as Form });
    } else {
      rewrite(view, { quote: !live.quote });
    }
  });
  dom.addEventListener("keydown", (event) => {
    const visible = buttons();
    const index = visible.indexOf(document.activeElement as HTMLButtonElement);
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape" || (mod && event.key === ".")) {
      event.preventDefault();
      returnToEditor(view);
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      visible[(index + step + visible.length) % visible.length]?.focus();
    }
  });
  dom.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (next !== null && (dom.contains(next) || view.contentDOM.contains(next)))
      return;
    dismiss(view);
  });

  sync();
  return { dom, update: sync };
}

const toolbarTheme = EditorView.theme({
  // Dressed like the completion panel (completionTheme) — the two are the
  // editor's only popups.
  ".cm-tooltip.cm-paste-options": {
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    boxShadow:
      "0 4px 6px -1px color-mix(in oklab, var(--foreground) 12%, transparent)",
    fontFamily: "var(--font-sans)",
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0.125rem",
    fontSize: "0.75rem",
  },
  ".cm-paste-forms": {
    display: "flex",
    paddingRight: "0.25rem",
    marginRight: "0.125rem",
    borderRight: "1px solid var(--border)",
  },
  ".cm-paste-forms[hidden]": { display: "none" },
  ".cm-paste-options button": {
    padding: "0.125rem 0.5rem",
    borderRadius: "0.375rem",
    color: "var(--muted-foreground)",
    cursor: "pointer",
  },
  ".cm-paste-options button:hover": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-paste-options button[aria-pressed='true']": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
    fontWeight: "500",
  },
  ".cm-paste-options button:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "-2px",
  },
});

/**
 * Paste as Markdown, as plain text or as a quote, and the toolbar that
 * switches between them after the fact.
 */
export function pasteAs(): Extension {
  return [
    liveField,
    pasteState,
    toolbarTheme,
    Prec.highest(
      keymap.of([
        {
          // Only while the toolbar is up; otherwise Escape is still the
          // editor's cancel.
          key: "Escape",
          run: (view) => {
            if (!view.state.field(liveField, false)) return false;
            view.dispatch({ effects: setLive.of(null) });
            return true;
          },
        },
      ]),
    ),
    keymap.of([
      {
        key: "Mod-Shift-v",
        // Noted, not handled: the browser's own paste event follows and
        // carries the clipboard.
        run: (view) => {
          const state = view.plugin(pasteState);
          if (state !== null) {
            state.intent = { plain: true, quote: false, at: Date.now() };
          }
          return false;
        },
      },
      { key: "Mod-Alt-v", run: pasteAsQuote(false) },
      { key: "Mod-Alt-Shift-v", run: pasteAsQuote(true) },
      {
        key: "Mod-.",
        run: (view) =>
          view.state.field(liveField, false) ? focusToolbar(view) : false,
      },
    ]),
    EditorView.domEventHandlers({
      blur: (event, view) => {
        const next = event.relatedTarget as Node | null;
        const toolbar = toolbarOf(view);
        if (next !== null && toolbar?.contains(next)) return false;
        dismiss(view);
        return false;
      },
    }),
  ];
}
