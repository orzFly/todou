import { useInfiniteQuery } from "@tanstack/react-query";
import type { TimelineItem, TimelinePage } from "@todou/shared";
import { api } from "@/api/queries.ts";

export const TIMELINE_PAGE_LIMIT = 50;

export type TimelinePageParam =
  | { dir: "init" }
  | { dir: "init-head" }
  | { dir: "before"; cursor: string }
  | { dir: "after"; cursor: string };

/**
 * Later pages may be empty (SSE-triggered forward polls), so the next
 * cursor is the newest non-null one across all pages — exported for tests.
 */
export function latestNextCursor(pages: TimelinePage[]): string | null {
  for (let i = pages.length - 1; i >= 0; i--) {
    const cursor = pages[i]?.next_cursor;
    if (cursor) return cursor;
  }
  return null;
}

/**
 * The newest window of the timeline (T-30 splits the old single query into
 * tail + head around a folded middle). Initial page is the newest one;
 * SSE invalidations refetch it and pick up appended items.
 */
export function useTimelineTail(slug: string, issueNumber: number) {
  return useInfiniteQuery({
    queryKey: ["timeline", slug, issueNumber, "tail"],
    initialPageParam: { dir: "init" } as TimelinePageParam,
    queryFn: ({ pageParam }) => {
      if (pageParam.dir === "before") {
        return api.getTimeline(slug, issueNumber, {
          before: pageParam.cursor,
          limit: TIMELINE_PAGE_LIMIT,
        });
      }
      if (pageParam.dir === "after") {
        return api.getTimeline(slug, issueNumber, {
          after: pageParam.cursor,
          limit: TIMELINE_PAGE_LIMIT,
        });
      }
      // Chat-style initial position: land on the newest page.
      return api.getTimeline(slug, issueNumber, {
        last: true,
        limit: TIMELINE_PAGE_LIMIT,
      });
    },
    getPreviousPageParam: (firstPage): TimelinePageParam | undefined =>
      firstPage.prev_cursor
        ? { dir: "before", cursor: firstPage.prev_cursor }
        : undefined,
    getNextPageParam: (_lastPage, allPages): TimelinePageParam | undefined => {
      const cursor = latestNextCursor(allPages);
      return cursor ? { dir: "after", cursor } : undefined;
    },
  });
}

/**
 * The head of the timeline: forward from the opened event, growing one
 * chunk per fetchNextPage — that is the fold block's "Load more". The gap
 * side has no server end-flag (next_cursor stays non-null so pollers can
 * continue), so callers gate expansion on the remaining count instead.
 */
export function useTimelineHead(
  slug: string,
  issueNumber: number,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: ["timeline", slug, issueNumber, "head"],
    enabled,
    initialPageParam: { dir: "init-head" } as TimelinePageParam,
    queryFn: ({ pageParam }) => {
      if (pageParam.dir === "after") {
        return api.getTimeline(slug, issueNumber, {
          after: pageParam.cursor,
          limit: TIMELINE_PAGE_LIMIT,
        });
      }
      // No cursor: forward from the very beginning.
      return api.getTimeline(slug, issueNumber, {
        limit: TIMELINE_PAGE_LIMIT,
      });
    },
    getNextPageParam: (_lastPage, allPages): TimelinePageParam | undefined => {
      const cursor = latestNextCursor(allPages);
      return cursor ? { dir: "after", cursor } : undefined;
    },
  });
}

/** The head query runs only when the newest page did not reach the start. */
export function needsHead(firstTailPage: TimelinePage | undefined): boolean {
  return Boolean(firstTailPage && firstTailPage.prev_cursor !== null);
}

export function flattenTimeline(pages: TimelinePage[]): TimelineItem[] {
  const seen = new Set<string>();
  const items: TimelineItem[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      const key = `${item.type}:${item.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }
  }
  return items;
}

/**
 * Both sides of the fold, deduplicated across the seam: a chunk that walked
 * into the tail's range would otherwise render those items twice (and
 * collide as React keys).
 */
export function mergeFolded(
  headPages: TimelinePage[],
  tailPages: TimelinePage[],
): { above: TimelineItem[]; below: TimelineItem[] } {
  const above = flattenTimeline(headPages);
  const seen = new Set(above.map((item) => `${item.type}:${item.id}`));
  const below = flattenTimeline(tailPages).filter(
    (item) => !seen.has(`${item.type}:${item.id}`),
  );
  return { above, below };
}

/**
 * Items still folded between the two sides. Self-consistent under churn:
 * an appended item raises the total and the rendered tail together; a
 * deletion inside the gap lowers only the total. Clamped — a transiently
 * stale total (head and tail responses race) must not un-fold the seam.
 */
export function remainingCount(
  totalCount: number,
  above: TimelineItem[],
  below: TimelineItem[],
): number {
  return Math.max(0, totalCount - above.length - below.length);
}

/** Follow the bottom only when the user is within one viewport of it. */
export function shouldFollowBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < clientHeight;
}
