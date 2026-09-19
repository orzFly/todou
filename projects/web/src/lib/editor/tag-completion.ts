import {
  acceptCompletion,
  type CompletionContext,
  type CompletionResult,
  clearSnippet,
  closeCompletion,
  nextSnippetField,
  prevSnippetField,
  snippet,
  snippetKeymap,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { inLiteralContext } from "@/lib/editor/code-context.ts";

type TagTemplate = { label: string; detail: string; template: string };

const TAG_TEMPLATES: TagTemplate[] = [
  {
    label: "<details>",
    detail: "Collapsible block",
    template: [
      "<details>",
      "<summary>",
      // Blank lines separate the summary tags from its Markdown title.
      "",
      `\${1:Title}`,
      "",
      "</summary>",
      // Blank lines around the body keep it outside the raw HTML blocks.
      "",
      `\${2:Body}`,
      "",
      "</details>",
      // A final field keeps backward navigation available from the body.
      `\${0}`,
    ].join("\n"),
  },
];

/** Only spaces and tabs are indentation; NBSP is not CommonMark indentation. */
export function tagTriggerAt(
  before: string,
  after: string,
): { at: number; query: string } | null {
  if (!/^\s*$/.test(after)) return null;
  // snippet copies indentation onto later lines, so arbitrary prefixes cannot work.
  const match = /^[ \t]*<([a-z]*)$/i.exec(before);
  if (match === null) return null;
  const query = match[1] as string;
  return { at: before.length - query.length - 1, query };
}

export function templatesFor(query: string): TagTemplate[] {
  const lower = query.toLowerCase();
  return TAG_TEMPLATES.filter((candidate) =>
    candidate.label.slice(1, -1).toLowerCase().startsWith(lower),
  );
}

export function tagCompletionSource(
  context: CompletionContext,
): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const offset = context.pos - line.from;
  const trigger = tagTriggerAt(
    line.text.slice(0, offset),
    line.text.slice(offset),
  );
  if (trigger === null) return null;
  // <details itself starts an HTMLBlock. inCodeContext would hide its template.
  if (inLiteralContext(syntaxTree(context.state), context.pos)) return null;
  const templates = templatesFor(trigger.query);
  if (templates.length === 0) return null;
  return {
    from: line.from + trigger.at,
    filter: false,
    options: templates.map(({ label, detail, template }) => ({
      label,
      detail,
      type: "tag",
      // completionWith orders unfiltered sources; boost applies if filtering is enabled.
      boost: 99,
      apply: snippet(template),
    })),
  };
}

/**
 * snippet installs a Prec.highest keymap, above the panel's ordinary Tab binding.
 * Its facet must accept a panel row before advancing the active snippet field.
 * Only the first snippetKeymap facet value is used. metadata-bulk-lang.ts has
 * another value, on a separate CodeEditor that does not use completionWith.
 */
export const snippetFieldKeys: Extension = snippetKeymap.of([
  {
    key: "Tab",
    run: (view) => acceptCompletion(view) || nextSnippetField(view),
    shift: prevSnippetField,
  },
  { key: "Escape", run: (view) => closeCompletion(view) || clearSnippet(view) },
]);
