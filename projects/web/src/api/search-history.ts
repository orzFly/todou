import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { meQuery } from "@/api/queries.ts";
import {
  forgetSearch,
  historyKey,
  parseHistory,
  recordSearch,
  type SearchHistoryEntry,
  subscribeHistory,
} from "@/lib/search-history.ts";

/**
 * This project's slice of the search history (T-270), and the two ways the
 * box changes it. Matching stays out here: the box holds the query, and
 * `matchHistory` is a pure function it can call itself.
 *
 * The snapshot stays the raw string, as in useProjectOrder: parsing in the
 * snapshot would mint a new object identity per call and spin
 * useSyncExternalStore forever.
 */
export function useSearchHistory(slug: string): {
  /** This project's entries, newest first. */
  entries: SearchHistoryEntry[];
  record: (q: string) => void;
  forget: (q: string) => void;
} {
  const me = useQuery(meQuery);
  // The login gate reads `me` before any project page renders, so this is the
  // real id rather than a guess that would later change keys underneath.
  const userId = me.data?.id ?? "anon";
  const raw = useSyncExternalStore(subscribeHistory, () => {
    try {
      return localStorage.getItem(historyKey(userId));
    } catch {
      return null;
    }
  });
  const entries = useMemo(() => parseHistory(raw)[slug] ?? [], [raw, slug]);
  const record = useCallback(
    (q: string) => recordSearch(userId, slug, q, Date.now()),
    [userId, slug],
  );
  const forget = useCallback(
    (q: string) => forgetSearch(userId, slug, q),
    [userId, slug],
  );
  return { entries, record, forget };
}
