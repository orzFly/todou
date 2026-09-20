import {
  drainPaged,
  type TimelineItem,
  type TimelinePage,
} from "@todou/shared";

export const TIMELINE_PAGE_LIMIT = 50;
export const READS = {
  include_hidden: true,
  limit: TIMELINE_PAGE_LIMIT,
} as const;
export const DRAIN_PAGE_LIMIT = 100;

export type TimelinePageParam =
  | { dir: "init" }
  | { dir: "init-head" }
  | { dir: "before"; cursor: string }
  | { dir: "after"; cursor: string };

export type TimelineWindowKind = "tail" | "head";
export interface TimelineWindow {
  initialPageParam?: TimelinePageParam;
  pageParams: TimelinePageParam[];
  depth?: number;
}
export interface TimelineWindowData {
  pages: TimelinePage[];
  pageParams: TimelinePageParam[];
}

/** The same request parameters are used by native page reads and shared recipes. */
export function timelinePageQuery(
  param: TimelinePageParam,
  kind: TimelineWindowKind = "tail",
): typeof READS & { before?: string; after?: string; last?: boolean } {
  if (param.dir === "after") return { ...READS, after: param.cursor };
  if (param.dir === "before" && kind === "tail") {
    return { ...READS, before: param.cursor };
  }
  return kind === "tail" ? { ...READS, last: true } : { ...READS };
}

export function timelineAllQuery(after?: string) {
  return { after, types: "comment,question_answered", limit: DRAIN_PAGE_LIMIT };
}

/** Empty forward polls retain the newest non-null cursor from earlier pages. */
export function latestNextCursor(pages: TimelinePage[]): string | null {
  for (let index = pages.length - 1; index >= 0; index--) {
    const cursor = pages[index]?.next_cursor;
    if (cursor) return cursor;
  }
  return null;
}

export function nextTimelinePageParam(
  pages: TimelinePage[],
): TimelinePageParam | undefined {
  const cursor = latestNextCursor(pages);
  return cursor ? { dir: "after", cursor } : undefined;
}

export function previousTimelinePageParam(
  firstPage: TimelinePage,
): TimelinePageParam | undefined {
  return firstPage.prev_cursor
    ? { dir: "before", cursor: firstPage.prev_cursor }
    : undefined;
}

export function timelineWindow(
  kind: TimelineWindowKind,
  pageParams?: readonly TimelinePageParam[],
): Required<TimelineWindow> {
  const initialPageParam: TimelinePageParam = {
    dir: kind === "tail" ? "init" : "init-head",
  };
  const params = pageParams?.length ? pageParams : [initialPageParam];
  return {
    initialPageParam,
    pageParams: params.map((param) => ({ ...param })),
    depth: params.length,
  };
}

/**
 * Match infinite-query refetch: begin at the oldest loaded request, then follow
 * fresh next cursors sequentially. Old later cursors can skip rows under churn.
 * Nothing is published until both arrays describe the complete rebuilt window.
 */
export async function rebuildTimelineWindow(
  window: TimelineWindow,
  readPage: (param: TimelinePageParam) => Promise<TimelinePage>,
): Promise<TimelineWindowData> {
  const pages: TimelinePage[] = [];
  const pageParams: TimelinePageParam[] = [];
  const depth = window.depth ?? window.pageParams.length;
  for (let index = 0; index < depth; index++) {
    const param =
      index === 0
        ? (window.pageParams[0] ?? window.initialPageParam)
        : nextTimelinePageParam(pages);
    if (!param) break;
    const page = await readPage(param);
    pages.push(page);
    pageParams.push(param);
  }
  return { pages, pageParams };
}

/** Keep drainPaged's has_more, empty-page, repeated-cursor and budget semantics. */
export async function drainTimelineComments(
  readPage: (after: string | undefined) => Promise<TimelinePage>,
): Promise<TimelineItem[]> {
  const { items } = await drainPaged<TimelineItem>(
    "timeline",
    undefined,
    readPage,
  );
  return items;
}
