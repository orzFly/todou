import { useState } from "react";

/**
 * The row geometry every picker shares — Status, Labels and every user picker
 * (T-458, T-677, T-739).
 *
 * One constant rather than a matching pair of class strings, because nothing
 * else would make a row in one the same height as a row in the other.
 *
 * `min-h-7.5` is 30px, the narrow row the user chose on T-739: a 22px chip
 * (16px of text inside a border and 2px of padding) plus this padding. It is
 * what makes the pickers equal rather than merely similar, because a user row
 * is built around a 20px avatar and would otherwise come out 2px shorter.
 * `label-status-rendering.test.ts` holds every status row to it.
 */
export const PICKER_ROW = "min-h-7.5 gap-2 px-2 py-1 text-sm";

/**
 * Sample selection at each open/query/candidate refresh, never on a toggle.
 * Candidate IDs (not array identity) distinguish new/deleted rows from a
 * parent render or a refetch returning the same list. Each partition retains
 * source order. Returning live items keeps renamed rows and avatars fresh.
 */
export function usePickerOrder<T>(
  items: T[],
  selectedIds: number[],
  idOf: (item: T) => number,
  open: boolean,
  query = "",
) {
  const candidates = JSON.stringify(items.map(idOf));
  const [snapshot, setSnapshot] = useState(() => ({
    open,
    query,
    candidates,
    selection: new Set(selectedIds),
  }));
  let selection = snapshot.selection;
  if (
    snapshot.open !== open ||
    snapshot.query !== query ||
    snapshot.candidates !== candidates
  ) {
    selection = new Set(selectedIds);
    // Synchronize during render so children never commit the previous order.
    // Selection alone is not a boundary; state survives discarded memo caches.
    setSnapshot({ open, query, candidates, selection });
  }
  return [
    ...items.filter((item) => selection.has(idOf(item))),
    ...items.filter((item) => !selection.has(idOf(item))),
  ];
}
