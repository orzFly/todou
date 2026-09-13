import {
  HighlightStyle,
  LRLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { parser as jsonParser } from "@lezer/json";

const jsonHighlighting = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--primary)" },
  { tag: tags.string, color: "var(--foreground)" },
  { tag: tags.number, color: "var(--foreground)" },
  { tag: [tags.bool, tags.null], color: "var(--muted-foreground)" },
  { tag: tags.punctuation, color: "var(--muted-foreground)" },
]);

/**
 * The JSON tab's language support. `@lezer/json` rather than
 * `@codemirror/lang-json`: the lang- package is a thin wrapper whose only
 * extra dependency is this same parser, and metadata values routinely hold
 * JSON, so hand-rolling a highlighter would be rewriting a worse version of
 * exactly the thing this does.
 */
export const metadataJsonSupport: Extension = [
  LRLanguage.define({ parser: jsonParser }),
  syntaxHighlighting(jsonHighlighting),
];
