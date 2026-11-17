import type { Element, ElementContent, Root } from "hast";
import { parseAttachmentHref } from "./attachment-refs.ts";
import { IMG_COMPARE_CLASS } from "./rehype-decorations.ts";

/**
 * Marks an `<img>` that stands for an author's pair (T-767): its labels come
 * from the two alts rather than the page's versions, and the spec diff leaves
 * its two sides alone. As React hands it to the `img` override.
 */
export const PAIR_ATTR = "data-compare-pair";
/** The first image's source offset, which the spec diff matches swaps against. */
export const PAIR_BEFORE_AT_ATTR = "data-pair-before-at";

const ARROW = /^\s*(?:→|->)\s*$/;

/**
 * The rule, hast side: a paragraph's children are exactly an image, an arrow
 * and an image. Its twin over the editor's syntax tree lives in
 * `editor/image-pairs.ts`; the two share one table of cases in the tests.
 */
export function imagePairOf(
  children: ElementContent[],
): { before: Element; after: Element } | null {
  const kids = children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  );
  if (kids.length !== 3) return null;
  const [before, arrow, after] = kids;
  if (before.type !== "element" || before.tagName !== "img") return null;
  if (after.type !== "element" || after.tagName !== "img") return null;
  if (arrow.type !== "text" || !ARROW.test(arrow.value)) return null;
  return { before, after };
}

const BLOCKS = new Set([
  "p",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "table",
  "div",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

function inlineRunLength(li: Element): number {
  const index = li.children.findIndex(
    (child) => child.type === "element" && BLOCKS.has(child.tagName),
  );
  return index === -1 ? li.children.length : index;
}

function addClass(element: Element, name: string): void {
  const existing = element.properties.className;
  element.properties.className = Array.isArray(existing)
    ? [...existing, name]
    : typeof existing === "string"
      ? [existing, name]
      : [name];
}

/**
 * Turns each pair into the second image alone, carrying the first's address
 * the way a spec swap does (T-722), so the `p` and `img` overrides in
 * `markdown-view.tsx` draw it as one comparison without a test of their own.
 * The `<img>` keeps its own position, which is what the spec diff and the
 * source-line stamps find it by.
 */
export function rehypeImagePairs() {
  const visit = (parent: Root | Element): void => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      // A tight list item has no `<p>`: its paragraph is the inline run its
      // children open with, before any nested block.
      const run =
        child.tagName === "p"
          ? child.children.length
          : child.tagName === "li"
            ? inlineRunLength(child)
            : 0;
      const pair = run === 0 ? null : imagePairOf(child.children.slice(0, run));
      if (pair === null) {
        visit(child);
        continue;
      }
      const { before, after } = pair;
      after.properties.dataSwapSrc = String(before.properties.src ?? "");
      after.properties.dataSwapAlt = String(before.properties.alt ?? "");
      after.properties.dataComparePair = "";
      after.properties.dataPairBeforeAt = String(
        before.position?.start.offset ?? "",
      );
      addClass(after, IMG_COMPARE_CLASS);
      child.children = [after, ...child.children.slice(run)];
      visit(child);
    }
  };
  return (tree: Root) => visit(tree);
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

function fileNameOf(src: string): string {
  const attachment = parseAttachmentHref(src)?.name;
  if (attachment != null) return attachment;
  let last: string;
  try {
    last = new URL(src, "http://x").pathname.split("/").pop() ?? "";
  } catch {
    return "";
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * One side's label: the author's alt, unless it says nothing an author chose —
 * empty, or the file name a paste or an upload put there.
 */
export function pairLabel(alt: string, src: string, fallback: string): string {
  const label = alt.trim();
  if (label === "" || label === fileNameOf(src) || IMAGE_NAME.test(label)) {
    return fallback;
  }
  return label;
}
