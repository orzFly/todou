import type { FetchQueryOptions, QueryClient } from "@tanstack/react-query";
import type {
  LocatedComment,
  ResolvedCommentRef,
  ResolvedIssueRef,
} from "@/api/issue-refs.ts";

type RefState<T> = {
  data: T | undefined;
  isPending: boolean;
  isFetching: boolean;
  fetchStatus?: "fetching" | "paused" | "idle";
  isStale: boolean;
  isError: boolean;
};

type IssueTarget = { slug: string; number: number };

/** A location response already authorizes the whole comment. Never re-stamp it. */
export function locatedCommentRef(
  slug: string,
  located: LocatedComment | null | undefined,
): ResolvedCommentRef | null {
  return located
    ? {
        ...located.comment,
        at: {
          slug: located.slug ?? slug,
          number: located.issue_number,
          commentId: located.comment.id,
        },
      }
    : null;
}

export function searchRefPending(ref: RefState<unknown>): boolean {
  return (
    ref.isPending ||
    ref.isFetching ||
    ref.fetchStatus === "paused" ||
    (ref.isStale && !ref.isError)
  );
}

function fresh<T>(
  ref: RefState<T>,
): ref is RefState<T> & { data: NonNullable<T> } {
  return (
    ref.data != null &&
    !ref.isFetching &&
    ref.fetchStatus !== "paused" &&
    !ref.isStale &&
    !ref.isError
  );
}

/** The hook and Enter must confirm the same complete, current parent/comment. */
export function confirmedSearchComment(
  input: IssueTarget,
  issue: RefState<ResolvedIssueRef | null>,
  comment: RefState<ResolvedCommentRef | null>,
): ResolvedCommentRef["at"] | null {
  if (!fresh(issue) || !fresh(comment) || issue.data.deleted_at != null) {
    return null;
  }
  const at = issue.data.at ?? input;
  if (issue.data.at === undefined && /^\d+$/.test(at.slug)) return null;
  return comment.data.at.slug === at.slug &&
    comment.data.at.number === at.number &&
    comment.data.at.commentId === comment.data.id
    ? comment.data.at
    : null;
}

/** Read current cache state, never just the data a completed promise returned. */
export function searchRefState<T>(
  client: QueryClient,
  options: FetchQueryOptions<T>,
): RefState<T> {
  const query = client.getQueryCache().find<T>({
    queryKey: options.queryKey,
    exact: true,
  });
  const state = query?.state;
  const staleTime = options.staleTime;
  return {
    data: state?.data,
    isPending: state === undefined || state.status === "pending",
    isFetching: state !== undefined && state.fetchStatus !== "idle",
    isStale:
      query === undefined ||
      query.isStaleByTime(
        typeof staleTime === "function" ? staleTime(query) : staleTime,
      ),
    isError: state?.status === "error",
  };
}

/** fetchQuery alone can return fresh cached data while a refetch is in flight. */
export async function fetchSearchRef<T>(
  client: QueryClient,
  options: FetchQueryOptions<T>,
): Promise<void> {
  const query = client.getQueryCache().find({
    queryKey: options.queryKey,
    exact: true,
  });
  if (query?.state.fetchStatus !== "idle" && query?.promise) {
    await query.promise;
  } else {
    await client.fetchQuery(options);
  }
}
