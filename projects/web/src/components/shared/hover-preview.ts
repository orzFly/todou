/**
 * What the two hover previews — a comment's and an issue's — have to agree
 * on. They open off the same links, so a pointer that crosses one and then
 * the other must not meet two different delays, and neither may open inside
 * the other.
 */

import { createContext, useContext } from "react";

/**
 * How many hover cards deep this subtree already is. A preview renders its
 * content through the same MarkdownView, so the references inside it would
 * become triggers of their own and nest without end.
 */
export const HoverDepth = createContext(0);

/** False inside a preview, where a second card may not open. */
export function useCanHoverPreview(): boolean {
  return useContext(HoverDepth) === 0;
}

/** Long enough that a pointer crossing a link on its way elsewhere is quiet. */
export const OPEN_DELAY_MS = 400;
export const CLOSE_DELAY_MS = 150;
