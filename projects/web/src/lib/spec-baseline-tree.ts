import type { Element, Root, RootContent } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { MARKDOWN_SYNTAX_PLUGINS } from "./markdown-processor.ts";
import { rehypeDetails } from "./rehype-details.ts";
import {
  CODE_CONTENT_START_ATTR,
  SOURCE_LINE_ATTR,
} from "./rehype-source-lines.ts";
import type { SourceBlock } from "./spec-source-index.ts";

/** The source identity shared with a structural block from `SegmentIndex`. */
export type BaselineBlockRef = Pick<SourceBlock, "type" | "start" | "end">;

/**
 * A complete rendered baseline and its semantic elements by source identity.
 *
 * The tree and index retain positions so callers can reuse the baseline. Use
 * `extractBaselineNode` for a detached subtree that is safe to insert into the
 * current document.
 */
export type BaselineTree = {
  tree: Root;
  nodes: ReadonlyMap<string, Element>;
  parents: ReadonlyMap<Element, Root | Element>;
};

export type BuildBaselineTreeOptions = {
  /**
   * The complete remark plugin list used by the corresponding MarkdownView.
   * Omit it for the shared static syntax used by context-free documents.
   */
  remarkPlugins?: PluggableList;
};

/** A stable map key for one structural source block. */
export function baselineNodeKey(block: BaselineBlockRef): string {
  return `${block.type}:${block.start}:${block.end}`;
}

function semanticType(node: Element): SourceBlock["type"] | null {
  switch (node.tagName) {
    case "p":
      return "paragraph";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listItem";
    case "blockquote":
      return "blockquote";
    case "pre":
      return "code";
    case "img":
      return "image";
    case "table":
      return Array.isArray(node.properties.className) &&
        node.properties.className.includes("markdown-frontmatter")
        ? "frontmatter"
        : "table";
    case "tr":
      return "tableRow";
    case "th":
    case "td":
      return "tableCell";
    default:
      return null;
  }
}

/** Index semantic HAST elements while their original source positions exist. */
export function indexBaselineTree(tree: Root): ReadonlyMap<string, Element> {
  const nodes = new Map<string, Element>();
  // Duplicate semantic ranges cannot identify a unique source block.
  const ambiguous = new Set<string>();

  const visit = (node: Root | Element): void => {
    if (node.type === "element") {
      const type = semanticType(node);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (type !== null && start !== undefined && end !== undefined) {
        const key = baselineNodeKey({ type, start, end });
        if (nodes.has(key)) {
          nodes.delete(key);
          ambiguous.add(key);
        } else if (!ambiguous.has(key)) {
          nodes.set(key, node);
        }
      }
    }
    for (const child of node.children) {
      if (child.type === "element") visit(child);
    }
  };

  visit(tree);
  return nodes;
}

function baselineParents(tree: Root): ReadonlyMap<Element, Root | Element> {
  const parents = new Map<Element, Root | Element>();
  const visit = (parent: Root | Element): void => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      parents.set(child, parent);
      visit(child);
    }
  };
  visit(tree);
  return parents;
}

/**
 * Parse a complete baseline document into the same safe HAST shape as
 * MarkdownView. Raw HTML stays as `raw` nodes; only the restricted details
 * syntax is converted to elements.
 */
export function buildBaselineTree(
  source: string,
  { remarkPlugins = MARKDOWN_SYNTAX_PLUGINS }: BuildBaselineTreeOptions = {},
): BaselineTree {
  const processor = unified()
    .use(remarkParse)
    .use(remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeDetails);
  const tree = processor.runSync(processor.parse(source), source) as Root;
  return {
    tree,
    nodes: indexBaselineTree(tree),
    parents: baselineParents(tree),
  };
}

function stripSourceMetadata(node: RootContent): void {
  delete node.position;
  if (node.type === "element") {
    delete node.properties[SOURCE_LINE_ATTR];
    delete node.properties[CODE_CONTENT_START_ATTR];
    for (const child of node.children) stripSourceMetadata(child);
  }
}

/** Identity of the nearest rendered shell absent from the source block index. */
export function baselineAncestor(
  baseline: BaselineTree,
  block: BaselineBlockRef,
  tagName: string,
): Element | null {
  const node = baseline.nodes.get(baselineNodeKey(block));
  if (node === undefined) return null;
  for (
    let parent = baseline.parents.get(node);
    parent?.type === "element";
    parent = baseline.parents.get(parent)
  ) {
    if (parent.tagName === tagName) return parent;
  }
  return null;
}

/**
 * Return a fresh, insertion-safe clone of a baseline semantic node.
 * Positions and current-document source markers are removed recursively;
 * the cached baseline and its index remain untouched and reusable.
 */
export function extractBaselineNode(
  baseline: BaselineTree,
  block: BaselineBlockRef,
): Element | null {
  const original = baseline.nodes.get(baselineNodeKey(block));
  if (original === undefined) return null;
  const clone = structuredClone(original);
  stripSourceMetadata(clone);
  return clone;
}
