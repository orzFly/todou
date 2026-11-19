import type { Element, ElementContent, Root } from "hast";
import { isEmbedImgNode, isSwapImgNode } from "./block-embeds.ts";
import { inlineRunLength } from "./rehype-image-pairs.ts";

const isBlank = (child: ElementContent): boolean =>
  child.type === "text" && child.value.trim() === "";

/**
 * Drops the line break that follows a block embed — a document card or an
 * image comparison — in a message (T-702). The embed already ends its own
 * line, so the `<br>` a single newline turned into would only add a blank
 * line under it, which two embeds on consecutive lines did not have before
 * newlines became breaks. A break before an embed stays: the text it ends is
 * inline, and the embed's own top edge does not separate them.
 *
 * `textEmbeds` says whether a text attachment draws as a card here, as the
 * `p` override in `markdown-view.tsx` decides; where it does not, it is a link
 * and its break is a real one.
 */
export function rehypeBlockBreaks({ textEmbeds }: { textEmbeds: boolean }) {
  const isBlock = (child: ElementContent): boolean =>
    isSwapImgNode(child) || (textEmbeds && isEmbedImgNode(child));
  const strip = (children: ElementContent[], run: number): ElementContent[] => {
    const kept: ElementContent[] = [];
    let previous: ElementContent | undefined;
    children.forEach((child, index) => {
      if (
        index < run &&
        child.type === "element" &&
        child.tagName === "br" &&
        previous !== undefined &&
        isBlock(previous)
      ) {
        return;
      }
      if (!isBlank(child)) previous = child;
      kept.push(child);
    });
    return kept;
  };
  const visit = (parent: Root | Element): void => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      // A tight list item has no `<p>`: its paragraph is the inline run its
      // children open with, before any nested block.
      if (child.tagName === "p") {
        child.children = strip(child.children, child.children.length);
      } else if (child.tagName === "li") {
        child.children = strip(child.children, inlineRunLength(child));
      }
      visit(child);
    }
  };
  return (tree: Root) => visit(tree);
}
