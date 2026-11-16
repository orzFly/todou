import { useCallback, useMemo, useRef, useState } from "react";

export type SelectionState = "none" | "some" | "all";

export interface Selection<K> {
  /** Selected keys, in the order of the list handed in — never stale. */
  selected: readonly K[];
  isSelected: (key: K) => boolean;
  /**
   * Flips one key. With `extend` (a shift-click), every key between the last
   * one toggled and this one takes this one's new state, as file managers do.
   */
  toggle: (key: K, options?: { extend?: boolean }) => void;
  /** The header checkbox: anything short of all selects all. */
  toggleAll: () => void;
  clear: () => void;
  state: SelectionState;
}

/**
 * Multi-select over a list whose membership changes under it (T-699): a key
 * that leaves the list — deleted, moved, filtered out — drops out of
 * `selected` on the same render, so an action can never reach something
 * the reader no longer sees.
 *
 * Kept free of any one list's shape so the issue list and the board can
 * select with it too.
 */
export function useSelection<K>(keys: readonly K[]): Selection<K> {
  const [picked, setPicked] = useState<ReadonlySet<K>>(() => new Set());
  const anchor = useRef<K | null>(null);

  const selected = useMemo(
    () => keys.filter((key) => picked.has(key)),
    [keys, picked],
  );
  const live = useMemo(() => new Set(selected), [selected]);

  const toggle = useCallback(
    (key: K, options?: { extend?: boolean }) => {
      const on = !live.has(key);
      const from = anchor.current === null ? -1 : keys.indexOf(anchor.current);
      const to = keys.indexOf(key);
      const span =
        options?.extend && from !== -1 && to !== -1
          ? keys.slice(Math.min(from, to), Math.max(from, to) + 1)
          : [key];
      anchor.current = key;
      const next = new Set(live);
      for (const k of span) {
        if (on) next.add(k);
        else next.delete(k);
      }
      setPicked(next);
    },
    [keys, live],
  );

  const clear = useCallback(() => {
    anchor.current = null;
    setPicked(new Set());
  }, []);

  const state: SelectionState =
    selected.length === 0
      ? "none"
      : selected.length === keys.length
        ? "all"
        : "some";

  const toggleAll = useCallback(() => {
    anchor.current = null;
    setPicked(state === "all" ? new Set() : new Set(keys));
  }, [keys, state]);

  const isSelected = useCallback((key: K) => live.has(key), [live]);

  return { selected, isSelected, toggle, toggleAll, clear, state };
}
