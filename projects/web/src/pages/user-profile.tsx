import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import { CalendarIcon } from "lucide-react";
import { userQuery } from "@/api/users.ts";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The user page (T-373). It answers one question — "who is this" — and
 * nothing else: their cards and projects are T-374's business.
 *
 * Reached by login (`/users/alice`) and, until the router replaces the
 * address, by id (`/users/12` → replace to `/users/alice`), which is the
 * form stored text links on.
 */
export function UserProfilePage({ ref }: { ref: string }) {
  const user = useQuery(userQuery(ref));

  if (user.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="size-16 rounded-full" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
    );
  }

  if (user.isError) {
    const status = (user.error as { status?: number }).status;
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="font-medium">
          {status === 404 ? "No such user here" : "Could not load this user"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {status === 404
            ? "The link may be old, or the account may be private to you."
            : "Try again in a moment."}
        </p>
      </div>
    );
  }

  const me = user.data;
  return (
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
  );
}

/**
 * The id-shaped half of the address: load by id, then hand the reader to
 * the login-shaped one with `replace`, so the URL bar ends up holding the
 * shareable form. A 404 here renders through UserProfilePage's error state
 * rather than a dangling skeleton.
 */
export function UserRedirectPage({ ref: id }: { ref: string }) {
  const user = useQuery(userQuery(id));
  if (user.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="size-16 rounded-full" />
        <Skeleton className="h-6 w-48" />
      </div>
    );
  }
  if (user.data === undefined) {
    // Unknown or invisible id: show the same page a bad login gets, by
    // rendering the profile page against the id itself.
    return <UserProfilePage ref={id} />;
  }
  return (
    <Navigate to="/users/$ref" params={{ ref: user.data.login }} replace />
  );
}
