import {
  CancelledError,
  type FetchQueryOptions,
  type Query,
  type QueryClient,
  type QueryKey,
  queryOptions,
} from "@tanstack/react-query";
import { type ActivityCalendarResponse, TodouError } from "@todou/shared";
import { api } from "@/api/queries.ts";

/** Dates and timezone are resolved by the caller, never from browser globals. */
export type ActivityCalendarRequest = {
  viewerId: number;
  /** Inclusive first local date of the window. */
  from: string;
  /** Exclusive last local date of the window. */
  to: string;
  day?: string;
  tz: string;
  limit?: number;
  after?: string;
};

export type ProjectActivityCalendarRequest = ActivityCalendarRequest & {
  projectId: number;
  slug: string;
};

export type UserActivityCalendarRequest = ActivityCalendarRequest & {
  subjectId: number;
};

export const activityKeys = {
  project: (slug?: string) =>
    slug === undefined
      ? (["activity-project"] as const)
      : (["activity-project", slug] as const),
  user: (subjectId?: number) =>
    subjectId === undefined
      ? (["activity-user"] as const)
      : (["activity-user", subjectId] as const),
};

function requestFields(input: ActivityCalendarRequest) {
  return {
    from: input.from,
    to: input.to,
    day: input.day,
    tz: input.tz,
    limit: input.limit ?? 50,
    after: input.after,
  };
}

function viewerOwnsKey(key: QueryKey, viewerId: number): boolean {
  const identity = key[2];
  return (
    (key[0] === "activity-project" || key[0] === "activity-user") &&
    typeof identity === "object" &&
    identity !== null &&
    "viewerId" in identity &&
    identity.viewerId === viewerId
  );
}

/**
 * A manual data write updates Query's cancellation rollback snapshot too.
 * setState alone would let cancelQueries/unmount restore the private old set.
 * QueryClient.setQueryData intentionally ignores undefined, so use Query's
 * public data setter to commit the empty snapshot without removing observers.
 */
function discardSnapshot(query: Query) {
  query.setData(undefined, { manual: true, updatedAt: 0 });
}

/** Keep observers attached, but withdraw every private snapshot for this viewer. */
async function clearPermissionData(
  client: QueryClient,
  viewerId: number,
  currentKey: QueryKey,
  signal: AbortSignal,
  error: TodouError,
) {
  const current = client
    .getQueryCache()
    .find({ queryKey: currentKey, exact: true });
  await client.cancelQueries({
    predicate: (query) =>
      query !== current && viewerOwnsKey(query.queryKey, viewerId),
  });
  // Logout/another cancellation may have happened while cancellation settled.
  if (signal.aborted) throw new CancelledError();
  for (const query of client.getQueryCache().findAll({
    predicate: (query) => viewerOwnsKey(query.queryKey, viewerId),
  })) {
    discardSnapshot(query);
    query.setState({ error, status: "error" });
  }
}

function calendarQuery(
  queryKey: QueryKey,
  viewerId: number,
  fetch: () => Promise<ActivityCalendarResponse>,
  restartOnConflict: boolean,
) {
  return queryOptions({
    queryKey,
    queryFn: async ({ client, signal }) => {
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw new CancelledError();
        try {
          const response = await fetch();
          // The transport currently cannot abort. Query cancellation must still
          // prevent a late response from becoming a cache or pagination write.
          if (signal.aborted) throw new CancelledError();
          return response;
        } catch (error) {
          if (signal.aborted) throw new CancelledError();
          if (error instanceof TodouError) {
            if ([401, 403, 404].includes(error.status)) {
              await clearPermissionData(
                client,
                viewerId,
                queryKey,
                signal,
                error,
              );
            } else if (error.status === 409 && restartOnConflict) {
              const query = client
                .getQueryCache()
                .find({ queryKey, exact: true });
              if (query) discardSnapshot(query);
              // Scope can change even during a first response. Restart once,
              // then expose persistent conflict without showing the old set.
              if (attempt === 0) continue;
            }
          }
          throw error;
        }
      }
    },
    retry: false,
    staleTime: 0,
    // A date/account/scope change must never carry the previous rows along.
    placeholderData: undefined,
  });
}

export function projectActivityCalendarQuery(
  request: ProjectActivityCalendarRequest,
) {
  const { viewerId, projectId, slug } = request;
  const input = requestFields(request);
  return calendarQuery(
    [...activityKeys.project(slug), { viewerId, projectId, ...input }],
    viewerId,
    () => api.getProjectActivityCalendar(slug, input),
    input.after === undefined,
  );
}

export function userActivityCalendarQuery(
  request: UserActivityCalendarRequest,
) {
  const { viewerId, subjectId } = request;
  const input = requestFields(request);
  return calendarQuery(
    [...activityKeys.user(subjectId), { viewerId, subjectId, ...input }],
    viewerId,
    () => api.getUserActivityCalendar(subjectId, input),
    input.after === undefined,
  );
}

/**
 * The first-page key owns one complete displayed response. Invalidation fetches
 * a new first response; successful continuations replace every calendar field
 * together with the accumulated cards. Callers can use an ordinary mutation
 * for loading/error state; a failed continuation leaves the complete old value.
 */
async function loadMore(
  client: QueryClient,
  first: FetchQueryOptions<ActivityCalendarResponse>,
  page: (after: string) => FetchQueryOptions<ActivityCalendarResponse>,
  signal?: AbortSignal,
): Promise<ActivityCalendarResponse | undefined> {
  if (signal?.aborted) throw new CancelledError();
  const root = client
    .getQueryCache()
    .find({ queryKey: first.queryKey, exact: true });
  const before = root?.state;
  const snapshot = client.getQueryData<ActivityCalendarResponse>(
    first.queryKey,
  );
  const cursor = snapshot?.selection?.next_cursor;
  if (!root || !before || !cursor || before.fetchStatus !== "idle") return;
  const continuation = before.isInvalidated ? first : page(cursor);
  const pageUpdates =
    client.getQueryState(continuation.queryKey)?.dataUpdateCount ?? 0;
  let activeKey = continuation.queryKey;
  const cancel = () => {
    void client.cancelQueries({ queryKey: activeKey, exact: true });
  };
  signal?.addEventListener("abort", cancel, { once: true });

  const isCurrent = () =>
    !signal?.aborted &&
    client.getQueryCache().find({ queryKey: first.queryKey, exact: true }) ===
      root &&
    root.state === before;
  try {
    const response = await client.fetchQuery(continuation);
    if (before.isInvalidated) return response;
    // Refetch, permission loss, logout, or a competing continuation wins over
    // this request. Never create the old base key again after cache.clear().
    if (!isCurrent()) return;
    // Query can resolve a canceled refetch with its cached data. Only a newly
    // successful page may extend the root; rollback does not increment this.
    if (
      (client.getQueryState(continuation.queryKey)?.dataUpdateCount ?? 0) <=
      pageUpdates
    )
      return;
    const previous = snapshot?.selection;
    const selection = response.selection;
    if (!previous || !selection || previous.date !== selection.date) return;
    const merged = {
      ...response,
      selection: {
        ...selection,
        items: [...previous.items, ...selection.items],
      },
    };
    client.setQueryData(first.queryKey, merged);
    return merged;
  } catch (error) {
    // Permission clearing deliberately changes the root state; still expose
    // the denial so the caller renders its error instead of an empty success.
    if (error instanceof TodouError && [401, 403, 404].includes(error.status)) {
      throw error;
    }
    if (before.isInvalidated && !(error instanceof CancelledError)) throw error;
    if (!isCurrent()) return;
    if (error instanceof TodouError && error.status === 409) {
      // Discard before the replacement request, including if that request
      // fails. A changed set must never retain an earlier page of cards.
      discardSnapshot(root);
      activeKey = first.queryKey;
      return await client.fetchQuery(first);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function loadMoreProjectActivityCalendar(
  client: QueryClient,
  request: ProjectActivityCalendarRequest,
  signal?: AbortSignal,
) {
  const input = { ...request, after: undefined };
  return loadMore(
    client,
    projectActivityCalendarQuery(input),
    (after) => projectActivityCalendarQuery({ ...input, after }),
    signal,
  );
}

export function loadMoreUserActivityCalendar(
  client: QueryClient,
  request: UserActivityCalendarRequest,
  signal?: AbortSignal,
) {
  const input = { ...request, after: undefined };
  return loadMore(
    client,
    userActivityCalendarQuery(input),
    (after) => userActivityCalendarQuery({ ...input, after }),
    signal,
  );
}
