import { useInfiniteQuery } from "@tanstack/react-query";
import type { TimelineItem, TimelinePage } from "@todou/shared";
import { api } from "@/api/queries.ts";

export type TimelinePageParam =
  | { dir: "init" }
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

export function useTimeline(slug: string, issueNumber: number) {
  return useInfiniteQuery({
    queryKey: ["timeline", slug, issueNumber],
    initialPageParam: { dir: "init" } as TimelinePageParam,
    queryFn: ({ pageParam }) => {
      if (pageParam.dir === "before") {
        return api.getTimeline(slug, issueNumber, {
          before: pageParam.cursor,
          limit: 50,
        });
      }
      if (pageParam.dir === "after") {
        return api.getTimeline(slug, issueNumber, {
          after: pageParam.cursor,
          limit: 50,
        });
      }
      // Chat-style initial position: land on the newest page.
      return api.getTimeline(slug, issueNumber, { last: true, limit: 50 });
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

/** Follow the bottom only when the user is within one viewport of it. */
export function shouldFollowBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < clientHeight;
}
