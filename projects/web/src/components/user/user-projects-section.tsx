import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { userProjectsQuery } from "@/api/users.ts";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { roleDotOf } from "@/lib/roles.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";
import { cn } from "@/lib/utils";

/** Rows to occupy the list while the seats load, at the height one holds. */
const SKELETONS = [0, 1, 2];

/**
 * Where this person holds a seat, and at what role (T-374) — narrowed to the
 * projects the reader can see.
 *
 * A row rather than the projects home's card (T-390): this list stands in the
 * user page's sidebar, which is a single narrow column, and the card carries a
 * three-line description and a REF watermark sized against its own box. The
 * seats are here to say *where* this person works, and the reader is one click
 * from the project itself for everything else.
 */
export function UserProjectsSection({ login }: { login: string }) {
  const query = userProjectsQuery(login);
  const projects = useQuery(query);
  const data = projects.data;
  const items = data?.items;
  const hasContent = data !== undefined;
  const { replace, notice } = useReadFailure(
    [projects.isError ? projects.error : null],
    hasContent,
    query.queryKey,
  );
  // `useProjectRefs` memoizes on the array's identity, so a `map` taken fresh
  // per render would rematch the whole directory on every one of them.
  const seats = useMemo(() => items?.map((item) => item.project), [items]);
  const refs = useProjectRefs(seats);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Their projects</h2>
      {notice && (
        <RefreshFailure
          what="these projects"
          detail={notice}
          onRetry={() => projects.refetch()}
          retrying={projects.isFetching}
        />
      )}

      {replace ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <LoadFailure
            message={`Could not load these projects: ${replace}`}
            detail={replace}
            onRetry={() => projects.refetch()}
            retrying={projects.isFetching}
            className="justify-center"
          />
        </div>
      ) : !hasContent ? (
        <div className="space-y-2">
          {SKELETONS.map((i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
          No projects you are both in 🥔
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg border">
          {data.items.map((item) => (
            <li key={item.project.id} className="border-b last:border-0">
              <Link
                to="/projects/$slug"
                params={{ slug: item.project.slug }}
                className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-muted/50"
              >
                <ProjectIcon
                  aria-hidden="true"
                  project={{
                    name: item.project.name,
                    prefix: refs.get(item.project.slug)?.prefix ?? null,
                    icon_url: item.project.icon_url,
                  }}
                  className="size-7 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {item.project.name}
                </span>
                <Badge variant="outline" className="shrink-0">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      roleDotOf(item.role),
                    )}
                    aria-hidden="true"
                  />
                  {item.role}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
