import {
  nextSnippetField,
  prevSnippetField,
  snippet,
  snippetKeymap,
} from "@codemirror/autocomplete";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { scanBulkEntries, scanBulkStop } from "../metadata-bulk.ts";

/**
 * Bulk tab highlighting (design: "Bulk 档"): a deliberately tiny stream
 * grammar. A comment line greys out; the `ns` half of the left side gets
 * colour, the key another; values and heredoc bodies stay unstyled, because
 * values are opaque strings and colour there would imply syntax that does
 * not exist.
 */
type BulkState = { inHeredoc: boolean };

const bulkLanguage = StreamLanguage.define<BulkState>({
  name: "metadata-bulk",
  startState: () => ({ inHeredoc: false }),
  tokenTable: {
    MetadataNamespace: tags.namespace,
    MetadataKey: tags.labelName,
    MetadataComment: tags.comment,
  },
  token(stream, state) {
    if (state.inHeredoc) {
      // The end mark must sit alone on its line; every body line is
      // consumed unstyled. A mark line simply ends the heredoc.
      if (stream.sol() && /^[A-Za-z0-9_-]+$/.test(stream.string)) {
        state.inHeredoc = false;
      }
      stream.skipToEnd();
      return null;
    }
    if (stream.sol() && stream.peek() === "#") {
      stream.skipToEnd();
      return "MetadataComment";
    }
    if (stream.sol()) {
      const rest = stream.string;
      const slash = rest.indexOf("/");
      const eq = rest.indexOf("=");
      if (slash > 0 && (eq === -1 || slash < eq)) {
        stream.pos = slash;
        return "MetadataNamespace";
      }
      stream.skipToEnd();
      return null;
    }
    // Right of the `=`: the value, unstyled — including heredoc bodies,
    // which flip the state once the `<<MARK` intro has been passed.
    if (state === undefined) return null;
    const rest = stream.string.slice(stream.pos);
    if (/^<<[A-Za-z0-9_-]+\s*$/.test(rest.trim()) && stream.pos > 0) {
      stream.skipToEnd();
      state.inHeredoc = true;
      return null;
    }
    stream.skipToEnd();
    return null;
  },
});

export const metadataBulkHighlighting = HighlightStyle.define([
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: tags.namespace, color: "var(--primary)", fontWeight: "600" },
  { tag: tags.labelName, fontFamily: "var(--font-mono)", fontWeight: "600" },
]);

/**
 * The Bulk editor's language support: stream highlighting plus the snippet
 * key bindings. The bindings ride on `snippetKeymap`, not the plain
 * `keymap`, because the snippet extension installs a `Prec.highest` keymap
 * of its own that would out-shout any ordinary `keymap.of` — tests rely on
 * exactly this: a Tab rebinding done on the wrong facet is silently
 * ignored, and a tab-through case then passes for the wrong reason.
 */
export const metadataBulkSupport: Extension = [
  bulkLanguage,
  syntaxHighlighting(metadataBulkHighlighting),
  snippetKeymap.of([
    { key: "Tab", run: nextSnippetField },
    { key: "Shift-Tab", run: prevSnippetField },
  ]),
];

/** Insert `${ns}/${key} = ${value}` with `ns` already filled. */
function insertSnippetAt(view: EditorView, template: string, at: number): void {
  snippet(template)(
    { state: view.state, dispatch: (d) => view.dispatch(d) },
    null,
    at,
    at,
  );
}

/**
 * Count the newlines immediately before `at`, then pad up to `want`. Only
 * the run of newlines ending at `at` counts — a longer run earlier in the
 * text is irrelevant, and a run already longer than `want` is not trimmed;
 * the separator only ever adds.
 *
 * The empty-document guard (`text.length === 0`) is DEFENSIVE: under the
 * line-start rule in `insertKeyInGroup`/`appendNewEntry` it is
 * unreachable — a zero-span heredoc-stop takes the template-with-trailing-
 * separator branch, not this one. Reverting it to the old `at === 0` form
 * turns no test red. It exists so the contract "an empty document needs no
 * separator" lives here and not in every caller.
 */
function separator(text: string, at: number, want: number): string {
  if (text.length === 0) return "";
  let have = 0;
  while (have < want && at - 1 - have >= 0 && text[at - 1 - have] === "\n") {
    have++;
  }
  return "\n".repeat(want - have);
}

/** True when `at` sits at the very start of a line that has content. */
function atLineStart(text: string, at: number): boolean {
  return at === 0 || text[at - 1] === "\n";
}

/**
 * The end of `namespace`'s group: the offset at the end of the last line
 * of the namespace's last complete entry, or null when the namespace has
 * no complete entry. Scanning stops at an unterminated heredoc, so this
 * never lands inside one — and the offset this returns is the end of the
 * *scanned* text when the scan stopped short of `doc.length`, never a
 * position inside the unparsed tail.
 */
function endOfGroup(view: EditorView, namespace: string): number | null {
  const text = view.state.doc.toString();
  const spans = scanBulkEntries(text);
  let endLine: number | null = null;
  for (const span of spans) {
    if (span.namespace === namespace) endLine = span.endLine;
  }
  if (endLine === null) return null;
  return view.state.doc.line(endLine).to;
}

/**
 * The offset just past the text the scanner could vouch for — `text.length`
 * when the scan covered the whole text, the end of the last vouched line
 * when it stopped at an unterminated heredoc. An insertion point is never
 * placed inside the tail the scanner cannot read.
 */
function scanEnd(view: EditorView): number {
  const text = view.state.doc.toString();
  const spans = scanBulkEntries(text);
  if (spans.length === 0) return scanEndWithoutSpans(view, text);
  const last = spans[spans.length - 1] as { endLine: number };
  return view.state.doc.line(last.endLine).to;
}

/**
 * No complete entry anywhere. The scan either walked the whole text
 * (empty, comments-only, invalid rows) and the end is `text.length`, or it
 * stopped at an unterminated heredoc intro line and the end is the
 * boundary *before* that line — the one position that is not inside the
 * body the scanner cannot read.
 */
function scanEndWithoutSpans(view: EditorView, text: string): number {
  if (text.length === 0) return 0;
  const stop = scanBulkStop(text);
  if (stop === null) return text.length;
  return view.state.doc.line(stop.line).from;
}

/**
 * True when the scan's stopping boundary is the *start* of a line the
 * scanner could not read past — the intro line of an unterminated heredoc.
 * The end of a vouched line is never a line start, so this distinguishes
 * "before unread content" from "after vouched content".
 */
function scanStoppedAtLineStart(view: EditorView, at: number): boolean {
  const text = view.state.doc.toString();
  if (text.length === 0) return false;
  if (!atLineStart(text, at)) return false;
  const line = view.state.doc.lineAt(at);
  // `at` must open a non-empty line (the unread intro) and must not also
  // close the previous line — the latter is a vouched line end.
  return (
    line.text.length > 0 &&
    line.from === at &&
    (at === 0 || view.state.doc.line(line.number - 1).to !== at)
  );
}

// Snippet field placeholders, spelled so the linter does not mistake them
// for accidental interpolation inside a template literal.
const KEY_FIELD = `\${key}`;
const VALUE_FIELD = `\${value}`;
const ENTRY_FIELDS = `\${ns}/\${key} = \${value}`;

/**
 * Insert a new-entry snippet at the end of the given namespace's group. The
 * namespace is already written, so the first snippet field the cursor lands
 * on is the key.
 */
export function insertKeyInGroup(view: EditorView, namespace: string): void {
  const text = view.state.doc.toString();
  const found = endOfGroup(view, namespace);
  // A namespace with no complete entry is a new group: at the end of the
  // scanned text, blank-line separated — not glued to a neighbour's value.
  const at = found ?? scanEnd(view);
  const template = `${namespace}/${KEY_FIELD} = ${VALUE_FIELD}`;
  if (found === null && scanStoppedAtLineStart(view, at)) {
    // The scan stopped at the *start* of an unread line (unterminated
    // heredoc is the text's first complete-entry candidate): the new group
    // must sit before that line, so the separation goes after the entry.
    insertSnippetAt(view, `${template}\n\n`, at);
  } else {
    const sep = separator(text, at, found === null ? 2 : 1);
    insertSnippetAt(view, `${sep}${template}`, at);
  }
  view.focus();
}

/**
 * Append a new-entry snippet at the very end of the document, separated by a
 * blank line when anything is there; the first field is the namespace.
 */
export function appendNewEntry(view: EditorView): void {
  const text = view.state.doc.toString();
  const at = scanEnd(view);
  if (scanStoppedAtLineStart(view, at)) {
    // Scan stopped at the start of an unread line (unterminated heredoc):
    // separation goes after the entry, before that line.
    insertSnippetAt(view, `${ENTRY_FIELDS}\n\n`, at);
  } else {
    const sep = separator(text, at, 2);
    insertSnippetAt(view, `${sep}${ENTRY_FIELDS}`, at);
  }
  view.focus();
}

/**
 * Select the value of `namespace/key` and scroll it into view — where
 * Browse's pencil icon lands after switching to Bulk.
 */
export function selectValueOf(
  view: EditorView,
  namespace: string,
  key: string,
): void {
  const prefix = `${namespace}/${key} = `;
  const text = view.state.doc.toString();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith(prefix)) {
      const lineInfo = view.state.doc.line(i + 1);
      const from = lineInfo.from + prefix.length;
      view.dispatch({
        selection: { anchor: from, head: lineInfo.to },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
  }
}
