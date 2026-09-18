import type { Nodes } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { type PluggableList, unified } from "unified";
import {
  FRONTMATTER_FLAVOURS,
  remarkFrontmatterTable,
} from "./remark-frontmatter-table.ts";
import { remarkRejectedUrlsAsText } from "./remark-rejected-urls.ts";

/**
 * Static Markdown syntax shared by every parser and renderer.
 *
 * Keep runtime-dependent plugins (issue references and occurrence counting)
 * in the caller: their options belong to the project/viewer context. Keeping
 * this array at module scope also lets renderers retain plugin-list identity
 * instead of rebuilding the invariant prefix on every render.
 *
 * The order is significant. Rejected URLs are restored to source text before
 * later tokenizers see them, and `remarkFrontmatterTable` consumes the nodes
 * produced by `remarkFrontmatter`.
 */
export const MARKDOWN_SYNTAX_PLUGINS: PluggableList = [
  remarkGfm,
  remarkRejectedUrlsAsText,
  [remarkFrontmatter, FRONTMATTER_FLAVOURS],
  remarkFrontmatterTable,
];
const processor = unified().use(remarkParse).use(MARKDOWN_SYNTAX_PLUGINS);

/**
 * `runSync`, not `parse` alone: `parse` stops at the tokenizer and runs no
 * transformer, so `remarkFrontmatterTable` — which is one — would never fire
 * and the caller would hold the `yaml` leaf while the DOM held a table.
 */
export function parseMarkdown(source: string): Nodes {
  return processor.runSync(processor.parse(source), source) as Nodes;
}
