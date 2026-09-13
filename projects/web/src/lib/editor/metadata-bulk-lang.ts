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

/** The offset just past the last line of `namespace`'s group, or EOF. */
function endOfGroup(view: EditorView, namespace: string): number {
  const doc = view.state.doc;
  const lines = doc.toString().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (line.startsWith(`${namespace}/`)) return doc.line(i + 1).to;
  }
  return doc.length;
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
  const at = endOfGroup(view, namespace);
  const sep = at < view.state.doc.length ? "\n" : "";
  insertSnippetAt(view, `${sep}${namespace}/${KEY_FIELD} = ${VALUE_FIELD}`, at);
  view.focus();
}

/**
 * Append a new-entry snippet at the very end of the document, separated by a
 * blank line when anything is there; the first field is the namespace.
 */
export function appendNewEntry(view: EditorView): void {
  const doc = view.state.doc;
  const at = doc.length;
  const sep = at === 0 ? "" : "\n\n";
  insertSnippetAt(view, `${sep}${ENTRY_FIELDS}`, at);
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
