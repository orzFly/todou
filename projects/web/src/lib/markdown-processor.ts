import type { Nodes } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  FRONTMATTER_FLAVOURS,
  remarkFrontmatterTable,
} from "./remark-frontmatter-table.ts";
import { remarkRejectedUrlsAsText } from "./remark-rejected-urls.ts";

/**
 * This list has to stay the same one `MarkdownView` renders with. Let the two
 * diverge and a reader of this tree sees a `heading` leaf where the DOM has a
 * table: every offset computed from it then lands on a node that is not there,
 * and `rehypeDecorations` drops what it cannot place *in silence*. The symptom
 * is decorations quietly vanishing, not an error — so plugins go in both
 * places at once (T-240).
 *
 * One module rather than one chain per caller, because the same list also
 * decides which lines `canonicalForDiff` may rewrite: without
 * `remarkFrontmatter` a frontmatter line starting with a digit parses as an
 * ordered list and gets a list marker stamped over it (T-383).
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRejectedUrlsAsText)
  .use(remarkFrontmatter, FRONTMATTER_FLAVOURS)
  .use(remarkFrontmatterTable);

/**
 * `runSync`, not `parse` alone: `parse` stops at the tokenizer and runs no
 * transformer, so `remarkFrontmatterTable` — which is one — would never fire
 * and the caller would hold the `yaml` leaf while the DOM held a table.
 */
export function parseMarkdown(source: string): Nodes {
  return processor.runSync(processor.parse(source), source);
}
