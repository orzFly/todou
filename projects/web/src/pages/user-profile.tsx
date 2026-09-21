import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { UserIssueRole, UserIssueState } from "@todou/shared";
import { CalendarIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { meQuery } from "@/api/queries.ts";
import { userQuery, userSearchParams } from "@/api/users.ts";
import type { ActivityDayChangeOptions } from "@/components/activity-calendar/activity-calendar-section.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { UserIssuesSection } from "@/components/user/user-issues-section.tsx";
import { UserProjectsSection } from "@/components/user/user-projects-section.tsx";
import {
  type ActivityDateSearch,
  activityToday,
  browserActivityTimezone,
  resolveActivityDateSearch,
  rollingActivityWindow,
} from "@/lib/activity-calendar-search.ts";
import { statusOf } from "@/lib/http-status";
import { useReadFailure } from "@/lib/use-read-failure.ts";
import { useReturnView } from "@/lib/use-return-view.ts";

const ActivityCalendarSection = lazy(() =>
  import("@/components/activity-calendar/activity-calendar-section.tsx").then(
    (module) => ({ default: module.ActivityCalendarSection }),
  ),
);

/**
 * The user page: who this is (T-373), the cards they are involved in and the
 * projects they hold a seat in (T-374). Every section shows only what the
 * *reader* may see, never what the subject may.
 *
 * Two columns from `lg` up. The left one answers "who is this" and never
 * changes while the reader is here; the right one is the part they come to
 * read, and the part that swaps: picking a day on the calendar puts that
 * day's cards where "Their cards" was, because two card lists one above the
 * other would leave the reader to work out which one their click had
 * answered. Page-level layout, so viewport breakpoints rather than container
 * queries — the column widths are a statement about the window.
 *
 * Reached by login (`/users/alice`) and, until the router replaces the
 * address, by id (`/users/12` → replace to `/users/alice`), which is the
 * form stored text links on.
 */
export function UserProfilePage({
  ref,
  role = "any",
  state = "open",
  activity_day,
  activity_invalid,
  onFilters = () => undefined,
  onActivityDateChange = () => undefined,
  redirectToLogin = false,
}: {
  ref: string;
  role?: UserIssueRole;
  state?: UserIssueState;
  onFilters?: (next: { role?: UserIssueRole; state?: UserIssueState }) => void;
  onActivityDateChange?: (
    next: ActivityDateSearch,
    options?: ActivityDayChangeOptions,
  ) => void;
  redirectToLogin?: boolean;
} & ActivityDateSearch) {
  const query = userQuery(ref);
  const user = useQuery(query);
  const viewer = useQuery({ ...meQuery, enabled: !redirectToLogin });
  const [activityContext] = useState(() => ({
    now: new Date(),
    timezone: browserActivityTimezone(),
  }));
  const activity = resolveActivityDateSearch(
    { activity_day, activity_invalid },
    activityContext,
  );
  const activityInvalidNotified = useRef(false);
  useEffect(() => {
    if (activity.invalid && !activityInvalidNotified.current) {
      activityInvalidNotified.current = true;
      toast("Invalid activity date was reset.");
      if (!redirectToLogin) {
        onActivityDateChange({ activity_day: activity.day }, { replace: true });
      }
    }
  }, [activity.invalid, activity.day, redirectToLogin, onActivityDateChange]);
  const data = user.data;
  const hasContent = data !== undefined;
  const { replace, notice } = useReadFailure(
    [user.isError ? user.error : null],
    hasContent,
    query.queryKey,
  );

  // The cards section owns the rows, so it is the one that can say when they
  // are up; a restore measuring this page while that section still shows its
  // skeleton would find nothing to anchor to and retire itself (T-407).
  const [rowsReady, setRowsReady] = useState(false);
  // Calendar loading changes the position of the card rows beneath it.
  const [calendarReady, setCalendarReady] = useState(false);
  // A day the calendar can actually answer for: the calendar is only mounted
  // once the viewer is known, and with it away there is no day list to put in
  // the cards' place — so the cards stay.
  const daySelected = viewer.data !== undefined && activity.day !== undefined;
  // The canonical login, never the id half of the address: `/users/12`
  // replaces itself with `/users/<login>`, and a snapshot naming the id would
  // send the reader back through that redirect. It is also the accessible
  // name on the back link, which would otherwise read "Back to User".
  const login = data?.login;
  useReturnView({
    target: {
      kind: "user",
      ref: login ?? ref,
      // Through the same schema the route validates with, which drops
      // whichever filter still sits at its default. The URL carries only
      // what the reader changed, so a target spelling the defaults out would
      // not describe the page it returns to.
      search: userSearchParams({ role, state, activity_day }),
    },
    userLabel: login,
    // Whichever list is standing in the right-hand column is the one a
    // restore has to wait for. With a day picked the cards section is not
    // mounted, and its parting `onReady(false)` would otherwise hold the page
    // un-measurable — and un-restorable — for as long as the day is selected.
    ready: daySelected ? calendarReady : rowsReady && calendarReady,
  });

  if (!replace && !hasContent) {
    return (
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        <div className="space-y-4">
          <Skeleton className="size-20 rounded-full lg:size-64" />
          <Skeleton className="h-6 w-48 max-w-full" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (user.isError || replace) {
    const status = statusOf(user.error);
    // 404 is an empty state, not a failure: there is nothing to retry into.
    if (status === 404) {
      return (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="font-medium">No such user here</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The link may be old, or the account may be private to you.
          </p>
        </div>
      );
    }
    if (replace) {
      return (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <LoadFailure
            message={`Could not load this user: ${replace}`}
            detail={replace}
            onRetry={() => user.refetch()}
            retrying={user.isFetching}
            className="justify-center"
          />
        </div>
      );
    }
  }

  const me = data as NonNullable<typeof data>;
  if (redirectToLogin) {
    return (
      <Navigate
        to="/users/$ref"
        params={{ ref: me.login }}
        search={userSearchParams({
          role,
          state,
          activity_day: activity.invalid ? activity.day : activity_day,
        })}
        replace
      />
    );
  }

  return (
    <div className="space-y-6">
      {notice && (
        <RefreshFailure
          what="this user"
          detail={notice}
          onRetry={() => user.refetch()}
          retrying={user.isFetching}
        />
      )}
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        {/* Below `lg` this column comes first and the reader scrolls past it,
            which is the order it is written in — identity, then where they
            work, then what they have been doing. */}
        <aside className="min-w-0 space-y-6">
          <div className="flex items-center gap-4 lg:block lg:space-y-4">
            {/* No bot badge on this one: the line below already says "agent",
                and at this size the badge's fixed corner offsets sit well
                outside the circle rather than on its edge.

                The fallback initials need the inherit rule to follow the two
                `text-*` sizes beside it: `UserAvatar` sets `text-[10px]` on
                the fallback itself, so a size passed to the box never reaches
                the letters — and at 256px they stay 10px tall with nothing in
                this call to explain why. */}
            <UserAvatar
              user={me}
              className="size-20 shrink-0 text-2xl lg:size-64 lg:text-7xl [&_[data-slot=avatar-fallback]]:text-[length:inherit]"
            />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold lg:text-2xl">
                {displayNameOf(me)}
              </h1>
              <p className="truncate text-muted-foreground lg:text-lg">
                @{me.login}
              </p>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            {me.kind === "machine" && (
              <p className="text-muted-foreground">
                agent{me.owner ? ` · belongs to @${me.owner.login}` : ""}
              </p>
            )}
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <CalendarIcon aria-hidden className="size-4" />
              joined {new Date(me.created_at).toLocaleDateString()}
            </p>
          </div>

          <UserProjectsSection login={me.login} />
        </aside>

        <div className="min-w-0 space-y-6">
          {viewer.data && (
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <ActivityCalendarSection
                viewerId={viewer.data.id}
                scope={{ kind: "user", subjectId: me.id }}
                {...rollingActivityWindow(
                  activityToday(activityContext.now, activityContext.timezone),
                )}
                day={activity.day}
                timezone={activityContext.timezone}
                today={activityToday(
                  activityContext.now,
                  activityContext.timezone,
                )}
                onReady={setCalendarReady}
                onInvalidDay={(day) => {
                  if (!activityInvalidNotified.current) {
                    activityInvalidNotified.current = true;
                    toast("Invalid activity date was reset.");
                  }
                  onActivityDateChange(
                    { activity_day: day },
                    { replace: true },
                  );
                }}
                onDayChange={(day, options) =>
                  onActivityDateChange({ activity_day: day }, options)
                }
                onClearDay={() =>
                  onActivityDateChange({ activity_day: undefined })
                }
              />
            </Suspense>
          )}

          {/* Keyed on the login: arriving by id renders this page once against
              the id before the redirect lands, and a stale section would
              otherwise keep querying the old ref. */}
          {!daySelected && (
            <UserIssuesSection
              key={me.login}
              login={me.login}
              role={role}
              state={state}
              onFilters={onFilters}
              onReady={setRowsReady}
            />
          )}
        </div>
      </div>
    </div>
  );
}
