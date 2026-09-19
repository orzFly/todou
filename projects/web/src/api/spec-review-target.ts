import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import {
  type SpecReviewResult,
  type TimelinePage,
  TodouError,
} from "@todou/shared";
import { api } from "@/api/queries.ts";
import { READS, type TimelinePageParam } from "@/api/timeline.ts";

const ROUND_BUDGET_MS = 1_250;
const ROUND_GAP_MS = 500;
const TOTAL_BUDGET_MS = ROUND_BUDGET_MS * 2 + ROUND_GAP_MS;
const MAX_PAGES_PER_ROUND = 3;

export type SpecReviewTargetResult =
  | { status: "found"; canNavigate: () => boolean }
  | { status: "not-found" | "cancelled" };

const TIMED_OUT = Symbol("timed-out");

/** Losing requests remain observed, including a rejection after the timer wins. */
async function withDeadline<T>(
  start: () => Promise<T>,
  deadline: number,
): Promise<T | typeof TIMED_OUT> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return TIMED_OUT;
  let timer: number | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = window.setTimeout(() => resolve(TIMED_OUT), remaining);
  });
  try {
    return await Promise.race([start(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call immediately after the review POST resolves. Each round owns its reads;
 * no late request can seed the cache or authorize navigation. The caller must
 * synchronously recheck canNavigate after settling submission state and before
 * navigating, since ownership or the deadline may change at that boundary.
 */
export async function prepareSpecReviewTarget({
  queryClient,
  slug,
  issueNumber,
  result,
  isCurrent,
}: {
  queryClient: QueryClient;
  slug: string;
  issueNumber: number;
  result: SpecReviewResult;
  isCurrent: () => boolean;
}): Promise<SpecReviewTargetResult> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const queryKey = ["timeline", slug, issueNumber, "tail"];

  for (let round = 0; round < 2; round++) {
    if (!isCurrent()) return { status: "cancelled" };
    if (Date.now() >= deadline) return { status: "not-found" };
    const roundDeadline = Math.min(deadline, Date.now() + ROUND_BUDGET_MS);
    let active = true;
    const canNavigate = () =>
      active &&
      isCurrent() &&
      Date.now() < roundDeadline &&
      Date.now() < deadline;
    const pages: TimelinePage[] = [];
    const pageParams: TimelinePageParam[] = [];
    const seenCursors = new Set<string>();
    let before: string | undefined;
    let preparing = false;

    try {
      for (let index = 0; index < MAX_PAGES_PER_ROUND; index++) {
        if (!canNavigate()) break;
        const pageParam: TimelinePageParam = before
          ? { dir: "before", cursor: before }
          : { dir: "init" };
        const page = await withDeadline(
          () =>
            api.getTimeline(slug, issueNumber, {
              ...READS,
              ...(pageParam.dir === "before"
                ? { before: pageParam.cursor }
                : { last: true }),
            }),
          roundDeadline,
        );
        // Check time again: promise callbacks may run after their round's timer
        // was due, even when the request won Promise.race.
        if (page === TIMED_OUT || !canNavigate()) break;
        pages.unshift(page);
        pageParams.unshift(pageParam);
        const found = page.items.some(
          (item) =>
            item.type === "event" &&
            item.id === result.event_id &&
            item.event_type === "spec_review" &&
            item.payload.version === result.version &&
            item.payload.verdict === result.verdict,
        );
        if (found) {
          preparing = true;
          const prepared = await withDeadline(
            () => queryClient.cancelQueries({ queryKey, exact: true }),
            roundDeadline,
          );
          // Cancellation can itself yield past the budget or lose ownership.
          // Never seed first and discover that at the navigation boundary.
          if (prepared === TIMED_OUT || !canNavigate()) {
            active = false;
            return { status: isCurrent() ? "not-found" : "cancelled" };
          }
          queryClient.setQueryData<
            InfiniteData<TimelinePage, TimelinePageParam>
          >(queryKey, { pages, pageParams });
          return { status: "found", canNavigate };
        }
        before = page.prev_cursor ?? undefined;
        if (!before || seenCursors.has(before)) break;
        seenCursors.add(before);
      }
    } catch (error) {
      // Permissions, missing/moved cards and invalid requests cannot become a
      // valid target on a retry. Transport and server failures get round two.
      if (
        preparing ||
        (error instanceof TodouError &&
          error.status >= 400 &&
          error.status < 500)
      ) {
        active = false;
        return { status: isCurrent() ? "not-found" : "cancelled" };
      }
    }
    active = false;
    if (!isCurrent()) return { status: "cancelled" };
    if (round === 0) {
      const remaining = Math.min(ROUND_GAP_MS, deadline - Date.now());
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
  }

  return { status: isCurrent() ? "not-found" : "cancelled" };
}
