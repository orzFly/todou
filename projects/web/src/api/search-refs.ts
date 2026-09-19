import {
  type Query,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
  type LocatedComment,
  type ResolvedCommentRef,
  type ResolvedIssueRef,
} from "@/api/issue-refs.ts";

export type {
  LocatedComment,
  ResolvedCommentRef,
  ResolvedIssueRef,
} from "@/api/issue-refs.ts";

function activeRevalidation<T>() {
  return {
    staleTime: 60_000,
    refetchInterval: (query: Query<T, Error, T, readonly unknown[]>) =>
      query.state.fetchStatus === "fetching"
        ? false
        : Math.max(
            1,
            60_000 -
              (Date.now() -
                Math.max(
                  query.state.dataUpdatedAt,
                  query.state.errorUpdatedAt,
                )),
          ),
  } as const;
}

/** Search confirms live targets independently of persistent display metadata. */
export const searchIssueRefQuery = (slug: string, number: number) =>
  queryOptions({
    queryKey: ["search-issue-ref", slug, number],
    queryFn: issueRefQuery(slug, number).queryFn,
    ...activeRevalidation<ResolvedIssueRef | null>(),
  });

export const searchCommentRefQuery = (
  slug: string,
  issueNumber: number,
  commentId: number,
) =>
  queryOptions({
    queryKey: ["search-comment-ref", slug, issueNumber, commentId],
    queryFn: commentRefQuery(slug, issueNumber, commentId).queryFn,
    ...activeRevalidation<ResolvedCommentRef | null>(),
  });

export const searchCommentLocationQuery = (slug: string, commentId: number) =>
  queryOptions({
    queryKey: ["search-comment-location", slug, commentId],
    queryFn: commentLocationQuery(slug, commentId).queryFn,
    ...activeRevalidation<LocatedComment | null>(),
  });

export type SearchRefInvalidationTarget = {
  slug?: string;
  issueNumber?: number;
  commentId?: number;
};

const matchesSearchRefTarget = (
  query: Query,
  target: SearchRefInvalidationTarget,
): boolean => {
  const [kind, slug, issueOrComment, commentId] = query.queryKey;
  if (
    kind !== "search-issue-ref" &&
    kind !== "search-comment-ref" &&
    kind !== "search-comment-location"
  ) {
    return false;
  }
  if (target.slug !== undefined && slug !== target.slug) return false;
  // A location key has no issue number. Invalidate all locations for this
  // project when an issue changes, since any of them may now point elsewhere.
  if (
    target.issueNumber !== undefined &&
    kind !== "search-comment-location" &&
    issueOrComment !== target.issueNumber
  ) {
    return false;
  }
  if (target.commentId !== undefined) {
    if (kind === "search-issue-ref") return false;
    const candidate =
      kind === "search-comment-ref" ? commentId : issueOrComment;
    if (candidate !== target.commentId) return false;
  }
  return true;
};

/**
 * Make matching reference metadata stale immediately, discard any in-flight
 * generation, then refresh observers that are currently active.
 */
export async function invalidateSearchRefQueries(
  client: QueryClient,
  target: SearchRefInvalidationTarget = {},
  options: {
    queryKey?: readonly unknown[];
    refetchType?: "active" | "none";
  } = {},
): Promise<void> {
  const filters = {
    queryKey: options.queryKey,
    predicate: (query: Query) => matchesSearchRefTarget(query, target),
  };
  const cancellation = client.cancelQueries(filters, { revert: false });
  void client.invalidateQueries({ ...filters, refetchType: "none" });
  await cancellation;
  if (options.refetchType !== "none") {
    await client.refetchQueries({ ...filters, type: "active" });
  }
}
