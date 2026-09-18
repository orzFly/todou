import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { UserIssueRole, UserIssueState } from "@todou/shared";
import { CalendarIcon } from "lucide-react";
import { userQuery } from "@/api/users.ts";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { UserIssuesSection } from "@/components/user/user-issues-section.tsx";
import { UserProjectsSection } from "@/components/user/user-projects-section.tsx";
import { statusOf } from "@/lib/http-status";
import { useReadFailure } from "@/lib/use-read-failure.ts";

/**
 * The user page: who this is (T-373), then the cards they are involved in
 * and the projects they hold a seat in (T-374). Both of those sections show
 * only what the *reader* may see, never what the subject may.
 *
 * Reached by login (`/users/alice`) and, until the router replaces the
 * address, by id (`/users/12` → replace to `/users/alice`), which is the
 * form stored text links on.
 */
export function UserProfilePage({
  ref,
  role = "any",
  state = "open",
  onFilters = () => undefined,
  redirectToLogin = false,
}: {
  ref: string;
  role?: UserIssueRole;
  state?: UserIssueState;
  onFilters?: (next: { role?: UserIssueRole; state?: UserIssueState }) => void;
  redirectToLogin?: boolean;
}) {
  const user = useQuery(userQuery(ref));
  const data = user.data;
  const hasContent = data !== undefined;
  const { replace, notice } = useReadFailure(
    user.isError ? user.error : null,
    hasContent,
  );

  if (!replace && !hasContent) {
    return (
      <div className="space-y-4">
        <Skeleton className="size-16 rounded-full" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
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
      <Navigate to="/users/$ref" params={{ ref: me.login }} search replace />
    );
  }

  return (
    <div className="space-y-8">
      {notice && (
        <RefreshFailure
          what="this user"
          detail={notice}
          onRetry={() => user.refetch()}
          retrying={user.isFetching}
        />
      )}
      <div className="max-w-lg space-y-6">
        <div className="flex items-center gap-4">
          <UserAvatar
            user={me}
            badge
            className="size-16 text-[20px] [&_svg]:size-4"
          />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">
              {displayNameOf(me)}
            </h1>
            <p className="text-muted-foreground">@{me.login}</p>
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
      </div>

      {/* Keyed on the login: arriving by id renders this page once against
          the id before the redirect lands, and a stale section would
          otherwise keep querying the old ref. */}
      <UserIssuesSection
        key={me.login}
        login={me.login}
        role={role}
        state={state}
        onFilters={onFilters}
      />
      <UserProjectsSection login={me.login} />
    </div>
  );
}

/**
 * The id-shaped half of the address (`/users/12`), which is the form stored
 * text links on. It renders the same page the login form does and hands the
 * reader on once the account resolves.
 *
 * Exactly one component may subscribe to `userQuery` for this address.
 * Rendering the page against a query this one had already failed gave the
 * cache two observers, and react-query refetches on mount while a query sits
 * in error with no data (`retryOnMount` defaults to true): the refetch reset
 * the query to pending, this component swapped back to its skeleton, the
 * second observer unmounted, and the failure repeated — a mount loop that
 * never showed the failure and never stopped asking (T-414).
 */
export function UserRedirectPage({ ref: id }: { ref: string }) {
  return <UserProfilePage ref={id} redirectToLogin />;
}
