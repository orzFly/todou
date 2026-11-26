import type { SelectionState } from "@orz/ui/hooks/use-selection";

/**
 * `state` over part of the list, such as one column of a board. A pure
 * function rather than the hook's own `state`, for a caller that holds the
 * picked set and must not take the hook's changing callbacks (board.tsx).
 */
export function groupState<K>(
  picked: ReadonlySet<K>,
  group: readonly K[],
): SelectionState {
  const count = group.filter((key) => picked.has(key)).length;
  return count === 0 ? "none" : count === group.length ? "all" : "some";
}
