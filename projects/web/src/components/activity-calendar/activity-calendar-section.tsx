import {
  hashKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ActivityCalendarResponse } from "@todou/shared";
import { useEffect, useRef } from "react";
import {
  loadMoreProjectActivityCalendar,
  loadMoreUserActivityCalendar,
  type ProjectActivityCalendarRequest,
  projectActivityCalendarQuery,
  type UserActivityCalendarRequest,
  userActivityCalendarQuery,
} from "@/api/activity-calendar.ts";
import { activityToday } from "@/lib/activity-calendar-search.ts";
import type { InsightsLink } from "@/lib/insights-selection.ts";
import { ActivityCalendar } from "./activity-calendar.tsx";
import { ActivityCardList } from "./activity-card-list.tsx";

/** Navigation hint for generated defaults; direct user selections omit it. */
export interface ActivityDayChangeOptions {
  replace?: boolean;
}

export interface ActivityCalendarSectionProps {
  /** Authenticated viewer identity; partitions all private query data. */
  viewerId: number;
  /** Canonical scope identity. The wrapper never fetches a user profile. */
  scope:
    | { kind: "project"; projectId: number; slug: string }
    | { kind: "user"; subjectId: number };
  /** Inclusive first local date of the window; URL parsing belongs to the caller. */
  from: string;
  /** Exclusive last local date of the window. */
  to: string;
  /** Requested YYYY-MM-DD, validated against recorded days before fetching cards. */
  day?: string;
  /** Explicit approved IANA timezone; no browser timezone policy lives here. */
  timezone: string;
  /** Explicit YYYY-MM-DD fallback until a response supplies its cutoff/timezone. */
  today: string;
  /** Page size, defaulting to the query API's 50. */
  limit?: number;
  /**
   * Hover and instant selection shared with the insights charts, forwarded
   * untouched. The profile page has no charts to link to and omits it.
   */
  link?: InsightsLink;
  /** The caller owns navigation and updates these controlled props. */
  /** Legal defaults pass { replace: true }; user selections omit options so callers can push history. */
  onDayChange: (day: string, options?: ActivityDayChangeOptions) => void;
  /** Supply to clear/notify rejected explicit days: replace with the recorded default, or clear when undefined. */
  onInvalidDay?: (replacement?: string) => void;
  /** Drop the selected day at the reader's request. Omit where no day can be selected. */
  onClearDay?: () => void;
  /** Reports settled base data/error/empty state for restoration, after any legal default is applied; false while fetching and on cleanup. */
  onReady?: (ready: boolean) => void;
}

type ScopedRequest =
  | (ProjectActivityCalendarRequest & { kind: "project" })
  | (UserActivityCalendarRequest & { kind: "user" });

function requestFor(props: ActivityCalendarSectionProps, day = props.day) {
  const common = {
    viewerId: props.viewerId,
    from: props.from,
    to: props.to,
    day,
    tz: props.timezone,
    limit: props.limit,
  };
  return props.scope.kind === "project"
    ? {
        kind: "project" as const,
        ...common,
        projectId: props.scope.projectId,
        slug: props.scope.slug,
      }
    : { kind: "user" as const, ...common, subjectId: props.scope.subjectId };
}

function optionsFor(request: ScopedRequest) {
  return request.kind === "project"
    ? projectActivityCalendarQuery(request)
    : userActivityCalendarQuery(request);
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Please try again.";
}

/** Owns requests and continuation lifecycle; both leaves receive one server snapshot. */
export function ActivityCalendarSection(props: ActivityCalendarSectionProps) {
  const client = useQueryClient();
  const request = requestFor(props);
  const initialRequest = { ...request, day: undefined };
  const initial = useQuery(optionsFor(initialRequest));
  const validDay =
    props.day !== undefined &&
    initial.data?.days.some(
      (day) => day.date === props.day && day.state === "recorded",
    ) === true;
  const selectedOptions = optionsFor(request);
  const requestKey = hashKey(selectedOptions.queryKey);
  const selected = useQuery({
    ...selectedOptions,
    enabled: validDay,
  });
  const query = validDay ? selected : initial;
  const options = validDay ? selectedOptions : optionsFor(initialRequest);
  const version = client.getQueryState(options.queryKey)?.dataUpdateCount;
  const response =
    query.data ??
    (validDay && selected.isPending && version === 0
      ? initial.data
      : undefined);
  const loading = query.isFetching || initial.isFetching;
  const today = response
    ? activityToday(new Date(response.cutoff), response.timezone)
    : initial.data
      ? activityToday(new Date(initial.data.cutoff), initial.data.timezone)
      : props.today;
  const defaulted = useRef(
    new Map<string, WeakSet<ActivityCalendarResponse>>(),
  );
  // A background refresh keeps the complete snapshot mounted. Withdrawing
  // layout readiness there would erase an otherwise readable return anchor.
  // A cold/withdrawn snapshot still waits, including 409 and permission clears.
  const ready =
    (query.data !== undefined || (!loading && query.isError)) &&
    !(
      props.day !== undefined &&
      !validDay &&
      initial.isSuccess &&
      initial.data !== undefined &&
      props.onInvalidDay
    );
  useEffect(() => {
    props.onReady?.(ready);
    return () => props.onReady?.(false);
  }, [props.onReady, ready]);

  useEffect(() => {
    if (
      !initial.isSuccess ||
      initial.data === undefined ||
      initial.isFetching ||
      validDay
    )
      return;
    const seen =
      defaulted.current.get(requestKey) ??
      new WeakSet<ActivityCalendarResponse>();
    if (seen.has(initial.data)) return;
    seen.add(initial.data);
    defaulted.current.set(requestKey, seen);
    // No day is picked for the reader. The calendar opens showing the whole
    // window, and the list below it stays empty until they choose one; a day
    // chosen for them would answer a question nobody asked.
    if (props.day !== undefined && props.onInvalidDay)
      props.onInvalidDay(undefined);
  }, [
    initial.data,
    initial.isSuccess,
    initial.isFetching,
    validDay,
    props.onInvalidDay,
    props.day,
    requestKey,
  ]);

  const inFlight = useRef<AbortController | null>(null);
  const continuation = useMutation({
    mutationFn: ({
      controller,
      request: pageRequest,
    }: {
      controller: AbortController;
      request: ScopedRequest;
      requestKey: string;
      version: number | undefined;
    }) =>
      pageRequest.kind === "project"
        ? loadMoreProjectActivityCalendar(
            client,
            pageRequest,
            controller.signal,
          )
        : loadMoreUserActivityCalendar(client, pageRequest, controller.signal),
    onSettled: (_data, _error, variables) => {
      if (inFlight.current === variables.controller) inFlight.current = null;
    },
  });

  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [],
  );

  // Identity changes always cancel the old request, including conflict recovery.
  const previousRequestKey = useRef(requestKey);
  useEffect(() => {
    if (previousRequestKey.current === requestKey) return;
    previousRequestKey.current = requestKey;
    inFlight.current?.abort();
    inFlight.current = null;
    continuation.reset();
  }, [requestKey, continuation.reset]);

  // Only a populated replacement supersedes a continuation. A 409 first
  // withdraws the snapshot (also incrementing its version), then uses this
  // same controller to fetch the replacement. Aborting on withdrawal would
  // cancel that recovery request before it can supply the new cards.
  const previousVersion = useRef(version);
  useEffect(() => {
    if (query.data === undefined || previousVersion.current === version) return;
    previousVersion.current = version;
    inFlight.current?.abort();
    inFlight.current = null;
    continuation.reset();
  }, [version, query.data, continuation.reset]);

  const loadMore = () => {
    if (
      inFlight.current ||
      loading ||
      query.isError ||
      initial.isError ||
      !response?.selection?.next_cursor
    )
      return;
    const controller = new AbortController();
    inFlight.current = controller;
    continuation.mutate({ controller, version, requestKey, request });
  };
  const continuationCurrent =
    continuation.variables?.requestKey === requestKey &&
    continuation.variables.version === version &&
    !continuation.variables?.controller.signal.aborted;
  const paginationError =
    continuation.isError && continuationCurrent
      ? errorText(continuation.error)
      : null;
  const failedQuery = query.isError ? query : initial.isError ? initial : null;
  const baseError = failedQuery ? errorText(failedQuery.error) : null;
  const retry = () => {
    void (failedQuery ?? query).refetch();
  };

  // A day was asked for and the window that decides whether it is a real one
  // has not landed. The list stands there as a skeleton from the first paint
  // rather than appearing under a grid the reader has already settled on,
  // which is also the one moment the page has nothing else to put there.
  const awaitingDay =
    props.day !== undefined && initial.data === undefined && !baseError;

  return (
    <div className="min-w-0 space-y-4">
      <ActivityCalendar
        from={props.from}
        to={props.to}
        days={response?.days ?? []}
        selection={response?.selection ?? null}
        today={today}
        link={props.link}
        onDayChange={props.onDayChange}
        onClear={props.onClearDay}
        loading={loading}
        error={response?.selection ? null : baseError}
        onRetry={retry}
      />
      {(response?.selection || (validDay && !baseError) || awaitingDay) && (
        <ActivityCardList
          selection={response?.selection ?? null}
          timezone={response?.timezone ?? props.timezone}
          loading={loading}
          loadingMore={
            continuation.isPending && continuationCurrent && !loading
          }
          error={baseError ?? paginationError}
          onLoadMore={loadMore}
          onRetry={baseError ? retry : loadMore}
        />
      )}
    </div>
  );
}
