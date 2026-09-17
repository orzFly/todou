import { parseSourceLoc, SOURCE_LINE_ATTR } from "@/lib/rehype-source-lines.ts";

/** The stamped block an endpoint sits in, or null where nothing stamped it. */
function blockRangeOf(node: Node): { start: number; end: number } | null {
  const el = node instanceof Element ? node : node.parentElement;
  const stamped = el?.closest(`[${SOURCE_LINE_ATTR}]`) ?? null;
  return stamped === null
    ? null
    : parseSourceLoc(stamped.getAttribute(SOURCE_LINE_ATTR));
}

/**
 * Which source lines the reader has selected inside `container`, for quoting
 * part of a body instead of all of it. Null means "no usable selection", and
 * the caller quotes the whole thing.
 *
 * Block granularity: selecting half a sentence quotes the whole paragraph.
 * That is the price of quoting the real markdown — emphasis, links and
 * fences all survive, where taking the rendered text would flatten them.
 */
export function selectedSourceRange(
  container: Element,
): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  if (selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }
  const from = blockRangeOf(range.startContainer);
  const to = blockRangeOf(range.endContainer);
  if (from === null || to === null) return null;
  return {
    start: Math.min(from.start, to.start),
    end: Math.max(from.end, to.end),
  };
}
