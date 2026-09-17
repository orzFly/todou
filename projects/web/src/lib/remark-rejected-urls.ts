import type { Nodes, Parent, Root, Text } from "mdast";
import { defaultUrlTransform } from "react-markdown";
import type { Plugin } from "unified";

/**
 * Whether react-markdown will refuse this URL's protocol.
 *
 * Asked of the renderer's own transform rather than of a second protocol
 * list: a safety predicate written twice is a safety predicate that will
 * eventually disagree with itself, and this one already has an answer.
 */
function rejected(url: string): boolean {
  return url !== "" && defaultUrlTransform(url) === "";
}

/** The node's own source, carrying its position so the offsets still line up. */
function asSource(node: Nodes, source: string): Text | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  return {
    type: "text",
    value: source.slice(start, end),
    position: node.position,
  };
}

function definitionsOf(node: Nodes, found: Map<string, string>): void {
  if (node.type === "definition") found.set(node.identifier, node.url);
  if (!("children" in node)) return;
  for (const child of node.children) definitionsOf(child, found);
}

/**
 * Show a link whose protocol is refused as the source the author wrote.
 *
 * react-markdown blanks the `href` of anything outside its protocol list,
 * which stops the script but leaves a link-shaped thing that reloads the page
 * when clicked. The same principle unsupported HTML is held to applies here:
 * what cannot be rendered is shown as what was typed.
 *
 * The substitution is byte-for-byte the node's own source, so the segment
 * index keeps reading the block as exact and every decoration offset inside
 * it stays where it was. Doing this on the hast side instead would leave the
 * index believing the block is a link the width of its label while the DOM
 * holds the longer source, and `rehypeDecorations` drops what it cannot place
 * in silence.
 *
 * A node with no position — one another plugin synthesised — keeps the
 * blanked attribute it has today: the script is still stopped, and only that
 * one link goes on showing nothing of where it pointed.
 */
export const remarkRejectedUrlsAsText: Plugin<[], Root> =
  () => (tree, file) => {
    const source = String(file);
    // A reference's URL lives on the definition line, which markdown never
    // renders — the reader is left with `[a][r]`, and the bad URL stays off
    // the page exactly as it is today.
    const definitions = new Map<string, string>();
    definitionsOf(tree, definitions);

    const urlOf = (node: Nodes): string | undefined => {
      if (node.type === "link" || node.type === "image") return node.url;
      if (node.type === "linkReference" || node.type === "imageReference") {
        return definitions.get(node.identifier);
      }
      return undefined;
    };

    const visit = (parent: Parent): void => {
      parent.children = parent.children.map((child) => {
        const url = urlOf(child);
        if (url !== undefined && rejected(url)) {
          return asSource(child, source) ?? child;
        }
        if ("children" in child) visit(child);
        return child;
      }) as typeof parent.children;
    };
    visit(tree);
  };
