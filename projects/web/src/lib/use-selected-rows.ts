import { useQueryClient } from "@tanstack/react-query";
import type { IssueCounts, IssueListItem, IssueListPage } from "@todou/shared";
import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * The cached list rows of a selection (T-775), from whichever page under
 * `["issues", slug]` holds each one — a list group, a flat page or a board
 * column. A selection holds numbers only, and what the bulk pickers show
 * (which labels all, some or none of the cards carry) is read off the rows.
 *
 * Follows the cache rather than a query, so an optimistic patch shows in
 * the open picker on the same frame it shows in the rows.
 */
export function useSelectedRows(
  slug: string,
  numbers: readonly number[],
): readonly IssueListItem[] {
  const queryClient = useQueryClient();
  const last = useRef<readonly IssueListItem[]>([]);

  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const getSnapshot = useCallback(() => {
    const wanted = new Set(numbers);
    const found = new Map<number, IssueListItem>();
    for (const [, data] of queryClient.getQueriesData<
      IssueListPage | IssueCounts
    >({ queryKey: ["issues", slug] })) {
      if (!data || !("items" in data)) continue;
      for (const item of data.items) {
        if (wanted.has(item.number) && !found.has(item.number)) {
          found.set(item.number, item);
        }
      }
    }
    const rows = numbers.flatMap((n) => {
      const row = found.get(n);
      return row ? [row] : [];
    });
    // The same rows as last time must be the same array, or
    // useSyncExternalStore re-renders forever.
    const previous = last.current;
    if (
      rows.length === previous.length &&
      rows.every((row, i) => row === previous[i])
    ) {
      return previous;
    }
    last.current = rows;
    return rows;
  }, [queryClient, slug, numbers]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
