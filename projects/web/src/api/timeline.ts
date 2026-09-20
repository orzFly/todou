import {
  hashKey,
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { TimelineItem, TimelinePage } from "@todou/shared";
import { api } from "@/api/queries.ts";
import {
  defineProjection,
  timelineAllResource,
  timelineResource,
} from "@/api/runtime/projections.ts";
import {
  runtimeQueryOptions,
  wrapRuntimeRefetch,
} from "@/api/runtime/query-adapter.ts";
import {
  drainTimelineComments,
  nextTimelinePageParam,
  previousTimelinePageParam,
  type TimelinePageParam,
  type TimelineWindowKind,
  timelineAllQuery,
  timelinePageQuery,
  timelineWindow,
} from "@/api/runtime/timeline.ts";

export { TIMELINE_PAGE_LIMIT } from "@/api/runtime/timeline.ts";

/**
 * Every comment on the card, however folded the page is (T-307). What the
 * reader can see is a head window and a tail window with an unloaded gap
 * between them, so a `/hide-all` computed from the rendered items would
 * silently miss the middle.
 *
 * No `include_hidden`: the selection needs `hidden_at`, `component`,
 * `resolved_at` and the author, never a body, and a blanked body is a
 * smaller response. `question_answered` rides along because it is the only
 * event `selectHidable` reads.
 *
 * Keyed under the card's timeline prefix so the existing
 * `invalidateQueries(["timeline", slug, number])` reaches it.
 */
export function allCommentsQuery(slug: string, issueNumber: number) {
  return runtimeQueryOptions(
    queryOptions({
      queryKey: ["timeline", slug, issueNumber, "all"] as const,
      queryFn: ({ signal }): Promise<TimelineItem[]> =>
        drainTimelineComments((after) =>
          api
            .withContext({
              signal,
              resource: timelineAllResource(slug, issueNumber, after),
            })
            .getTimeline(slug, issueNumber, timelineAllQuery(after)),
        ),
    }),
    {
      kind: "timeline-all",
      resources: [timelineAllResource(slug, issueNumber)],
    },
  );
}

export type { TimelinePageParam } from "@/api/runtime/timeline.ts";
/**
 * Every page this app reads carries the hidden bodies (T-281). Revealing a
 * run is a view toggle here, not a read: one person looking at one card is
 * the whole budget, and the cost worth saving is the round trip, not the
 * bytes. It also keeps `total_count` in the relation the fold arithmetic
 * already assumes — rows and count stay exactly as they were.
 *
 * A constant, so it is not part of any query key.
 */
/**
 * Later pages may be empty (SSE-triggered forward polls), so the next
 * cursor is the newest non-null one across all pages — exported for tests.
 */
export { latestNextCursor, READS } from "@/api/runtime/timeline.ts";

/** Query identity stays page-local; shared projection identity includes its window. */
export function timelineProjection(
  slug: string,
  issueNumber: number,
  kind: TimelineWindowKind,
  pageParams?: readonly TimelinePageParam[],
) {
  const queryKey = ["timeline", slug, issueNumber, kind];
  const windowDescriptor = timelineWindow(kind, pageParams);
  return defineProjection({
    kind: kind === "tail" ? "timeline-tail" : "timeline-head",
    version: 1,
    queryKey,
    queryHash: hashKey(queryKey),
    resources: [
      timelineResource(
        slug,
        issueNumber,
        windowDescriptor.initialPageParam,
        kind,
      ),
    ],
    windowDescriptor,
  });
}

/**
 * The newest window of the timeline (T-30 splits the old single query into
 * tail + head around a folded middle). Initial page is the newest one;
 * SSE invalidations refetch it and pick up appended items.
 */
export function timelineTailOptions(slug: string, issueNumber: number) {
  return runtimeQueryOptions(
    infiniteQueryOptions({
      queryKey: ["timeline", slug, issueNumber, "tail"],
      initialPageParam: { dir: "init" } as TimelinePageParam,
      queryFn: ({ pageParam, signal, meta }) =>
        api
          .withContext({
            signal,
            freshnessMs: (meta?.runtime as { freshnessMs?: number } | undefined)
              ?.freshnessMs,
            resource: timelineResource(slug, issueNumber, pageParam, "tail"),
          })
          .getTimeline(slug, issueNumber, timelinePageQuery(pageParam, "tail")),
      getPreviousPageParam: previousTimelinePageParam,
      getNextPageParam: (_lastPage, allPages) =>
        nextTimelinePageParam(allPages),
    }),
    timelineProjection(slug, issueNumber, "tail"),
  );
}

export function useTimelineTail(slug: string, issueNumber: number) {
  const queryClient = useQueryClient();
  const options = timelineTailOptions(slug, issueNumber);
  return wrapRuntimeRefetch(
    queryClient,
    options.queryKey,
    useInfiniteQuery(options),
  );
}

/**
 * The head of the timeline: forward from the opened event, growing one
 * chunk per fetchNextPage — that is the fold block's "Load more". The gap
 * side has no server end-flag (next_cursor stays non-null so pollers can
 * continue), so callers gate expansion on the remaining count instead.
 */
export function timelineHeadOptions(
  slug: string,
  issueNumber: number,
  enabled: boolean,
) {
  return runtimeQueryOptions(
    infiniteQueryOptions({
      queryKey: ["timeline", slug, issueNumber, "head"],
      enabled,
      initialPageParam: { dir: "init-head" } as TimelinePageParam,
      queryFn: ({ pageParam, signal, meta }) =>
        api
          .withContext({
            signal,
            freshnessMs: (meta?.runtime as { freshnessMs?: number } | undefined)
              ?.freshnessMs,
            resource: timelineResource(slug, issueNumber, pageParam, "head"),
          })
          .getTimeline(slug, issueNumber, timelinePageQuery(pageParam, "head")),
      getNextPageParam: (_lastPage, allPages) =>
        nextTimelinePageParam(allPages),
    }),
    timelineProjection(slug, issueNumber, "head"),
  );
}

export function useTimelineHead(
  slug: string,
  issueNumber: number,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const options = timelineHeadOptions(slug, issueNumber, enabled);
  return wrapRuntimeRefetch(
    queryClient,
    options.queryKey,
    useInfiniteQuery(options),
  );
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
