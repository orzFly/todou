import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatRef, type MutedIssue, type MutedProject } from "@todou/shared";
import {
  issueMuteLabels,
  mutesQuery,
  useUnmuteIssue,
  useUnmuteProject,
} from "@/api/mutes.ts";
import { useRefPrefix } from "@/api/references.ts";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function MutedPage() {
  const {
    data: mutes,
    isPending,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery(mutesQuery);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Muted</h1>
        <Link
          to="/inbox"
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Inbox
        </Link>
      </div>
      {isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <LoadFailure
            message={`Could not load the muted list: ${error.message}`}
            detail={error.message}
            onRetry={() => refetch()}
            retrying={isFetching}
            className="justify-center"
          />
        </div>
      ) : mutes.projects.length === 0 && mutes.issues.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          Nothing is muted. A muted card or project stays out of the Inbox and
          its unread markers go grey.
        </div>
      ) : (
        <>
          {mutes.projects.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-medium">Projects</h2>
              <ul className="divide-y rounded-lg border px-3.5">
                {mutes.projects.map((project) => (
                  <MutedProjectRow key={project.slug} project={project} />
                ))}
              </ul>
            </section>
          )}
          {mutes.issues.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-medium">Issues</h2>
              <ul className="divide-y rounded-lg border px-3.5">
                {mutes.issues.map((issue) => (
                  <MutedIssueRow
                    key={`${issue.project.slug}-${issue.number}`}
                    issue={issue}
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function MutedProjectRow({ project }: { project: MutedProject }) {
  const unmute = useUnmuteProject();
  return (
    <li className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-1">
        <Link
          to="/projects/$slug"
          params={{ slug: project.slug }}
          className="block truncate text-sm underline-offset-2 hover:underline"
        >
          {project.name}
        </Link>
        <time
          dateTime={project.muted_at}
          title={project.muted_at}
          className="block text-xs text-muted-foreground"
        >
          {new Date(project.muted_at).toLocaleString()}
        </time>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
        disabled={unmute.isPending}
        onClick={() => unmute.mutate({ slug: project.slug })}
      >
        Unmute
      </Button>
    </li>
  );
}

export function MutedIssueRow({ issue }: { issue: MutedIssue }) {
  const prefix = useRefPrefix(issue.project.slug);
  const unmute = useUnmuteIssue();
  // Always `undefined` today, and deliberately so: this page registers no
  // collection of its own, and the one link that reaches it — the inbox's
  // Muted control — passes no origin, because the entry matrix does not infer
  // one for a page like this. A card opened from here therefore falls back to
  // its own project's list, which is the wanted behaviour (T-407).
  //
  // The call stays because every link into a detail page makes it, and an
  // exception is what a later reader would have to notice: the day this page
  // registers itself, or is arrived at carrying an origin, these rows carry it
  // with no further change.
  const returnState = useReturnLinkState();
  return (
    <li className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-1">
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug: issue.project.slug, number: String(issue.number) }}
          state={returnState}
          className="block truncate text-sm underline-offset-2 hover:underline"
        >
          {issue.project.name} {formatRef(prefix, issue.number)} — {issue.title}
        </Link>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{issueMuteLabels[issue.mode]}</span>
          <time dateTime={issue.muted_at} title={issue.muted_at}>
            {new Date(issue.muted_at).toLocaleString()}
          </time>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
        disabled={unmute.isPending}
        onClick={() =>
          unmute.mutate({ slug: issue.project.slug, number: issue.number })
        }
      >
        Unmute
      </Button>
    </li>
  );
}
