import type { BlockRef } from "@todou/shared";

/**
 * How many cards are still holding this one up (T-377) — cleared edges are
 * history, not a reason to leave the card alone. Shared by every surface
 * that wears the blocked badge, so a list row and a board card can never
 * disagree about whether a card is blocked.
 *
 * A hidden edge counts: the reader may not see what is in the way, but
 * something is.
 */
export function openBlockCount(refs: BlockRef[] | undefined): number {
  return (refs ?? []).filter((ref) => ref.cleared_at === null).length;
}
