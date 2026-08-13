import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InboxItem } from "@todou/shared";
import { useEffect } from "react";
import { api, meQuery } from "@/api/queries.ts";

export const inboxQuery = queryOptions({
  queryKey: ["inbox"],
  queryFn: () => api.getInbox(),
});

export type InboxGroup = { project: InboxItem["project"]; items: InboxItem[] };

/**
 * Fold the flat /me/inbox payload into per-project groups. Items arrive
 * sorted by last_activity_at desc, so the first sighting of a project is
 * its newest row: insertion order doubles as the group order, and rows
 * keep the server order within each group.
 */
export function groupInboxItems(items: InboxItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const item of items) {
    const group = groups.get(item.project.slug);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(item.project.slug, {
        project: item.project,
        items: [item],
      });
    }
  }
  return [...groups.values()];
}

export const INBOX_POLL_MS = 30_000;
export const INBOX_FALLBACK_MS = 60_000;

type ActivitySignalPage = { items: unknown[]; next_cursor: string | null };

// Module-level so the default keeps one identity across renders — an
// inline `(url) => fetch(url)` default would land in the effect deps and
// restart the poll loop (cursor, downgrade state and all) on every
// re-render of the mounting component.
const defaultFetcher = (url: string) => fetch(url);

/**
 * Change signal for the inbox: poll T-93's cross-project activity endpoint
 * with a session-held cursor and invalidate ["inbox"] whenever someone
 * else's activity lands. The cursor is an opaque server-minted envelope —
 * held in memory only, never persisted (losing it just re-bootstraps).
 * A server without the endpoint (pre-T-93) answers 404 once; we then stop
 * probing and downgrade to slow whole-query refetches. Read positions are
 * private and eventless, so a mark-read on another machine never signals —
 * react-query's focus refetch covers that gap.
 */
export function useInboxSignal(
  fetcher: (url: string) => Promise<Response> = defaultFetcher,
) {
  const queryClient = useQueryClient();
  const meId = useQuery(meQuery).data?.id;

  useEffect(() => {
    if (meId === undefined) return;
    let disposed = false;
    let inFlight = false;
    let cursor: string | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | undefined;

    const timer = setInterval(() => void poll(), INBOX_POLL_MS);
    const downgrade = () => {
      clearInterval(timer);
      fallbackTimer = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ["inbox"] });
      }, INBOX_FALLBACK_MS);
    };

    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const params = new URLSearchParams({ exclude_actor: String(meId) });
        if (cursor === null) params.set("last", "1");
        else params.set("after", cursor);
        const res = await fetcher(`/api/activity?${params}`);
        if (disposed) return;
        if (res.status === 404) {
          downgrade();
          return;
        }
        if (!res.ok) return; // transient — same cursor next tick
        const page = (await res.json()) as ActivitySignalPage;
        // The bootstrap round (last=1) returns no items by contract; only
        // genuine increments invalidate.
        if (cursor !== null && page.items.length > 0) {
          queryClient.invalidateQueries({ queryKey: ["inbox"] });
        }
        if (page.next_cursor !== null) cursor = page.next_cursor;
      } catch {
        // Network hiccup: keep the cursor, retry on the next tick.
      } finally {
        inFlight = false;
      }
    };

    void poll();
    return () => {
      disposed = true;
      clearInterval(timer);
      if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
    };
  }, [meId, queryClient, fetcher]);
}
