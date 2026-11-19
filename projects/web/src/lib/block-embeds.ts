import type { Element, ElementContent } from "hast";
import { isTextEmbedName } from "./attachment-preview.ts";
import { parseAttachmentHref } from "./attachment-refs.ts";

/**
 * True when this img node is one our override turns into a document card.
 *
 * Deliberately answers from the markdown alone — no slug test, no attachment
 * data. It decides between `<p>` and `<div>`, and an element type that
 * flipped when the attachments query arrived would unmount and rebuild the
 * whole paragraph, which is exactly what the T-60 note in `markdown-view.tsx`
 * warns about. The cost of being generous is a paragraph rendered as
 * `div.markdown-paragraph` when the address turns out to resolve to nothing;
 * the two share their typography. Being strict instead would put a block
 * document card inside a `<p>`, which browsers split the paragraph over.
 */
export function isEmbedImgNode(child: Element | ElementContent): boolean {
  if (child.type !== "element" || child.tagName !== "img") return false;
  const src = child.properties.src;
  const ref = typeof src === "string" ? parseAttachmentHref(src) : null;
  return ref !== null && isTextEmbedName(ref.name ?? "");
}

/**
 * True when this img node is a swapped image our override turns into an
 * image comparison (T-722), which is block content too. Answers from the
 * tree alone, for the reason `isEmbedImgNode` gives.
 */
export function isSwapImgNode(child: Element | ElementContent): boolean {
  return (
    child.type === "element" &&
    child.tagName === "img" &&
    typeof child.properties.dataSwapSrc === "string"
  );
}
