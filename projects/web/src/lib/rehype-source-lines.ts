import type { Element, Root } from "hast";

/**
 * Block-level tags that make useful annotation anchors. Inline elements are
 * skipped: a selection maps to its closest block, which is the granularity
 * spec comments anchor at (redline did the same via sourcepos).
 */
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "pre",
  "blockquote",
  "table",
  "hr",
]);

export const SOURCE_LINE_ATTR = "data-loc";

/** `data-loc="start-end"` → 1-based inclusive source line range. */
export function parseSourceLoc(
  value: string | null | undefined,
): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

/**
 * Rehype plugin stamping every block element with the markdown source line
 * range it was rendered from. This is the whole bridge between "what the
 * reviewer selected in the rendered document" and "which source lines the
 * anchor stores" — remark/rehype keep positions intact, so no offset math.
 */
export function rehypeSourceLines() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      if (
        node.type === "element" &&
        BLOCK_TAGS.has(node.tagName) &&
        node.position?.start.line !== undefined &&
        node.position.end.line !== undefined
      ) {
        node.properties[SOURCE_LINE_ATTR] =
          `${node.position.start.line}-${node.position.end.line}`;
      }
      if ("children" in node) {
        for (const child of node.children) {
          if (child.type === "element") visit(child);
        }
      }
    };
    visit(tree);
  };
}
