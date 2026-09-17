import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { userProjectsQuery } from "@/api/users.ts";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Where this person holds a seat, and at what role (T-374) — narrowed to
 * the projects the reader can see. Rows are `Link`s, which render real
 * anchors, so middle-click and ⌘-click reach the project.
 */
export function UserProjectsSection({ login }: { login: string }) {
  const projects = useQuery(userProjectsQuery(login));

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Ta 的项目</h2>
      {projects.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : projects.isError ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <LoadFailure
            message={`Could not load these projects: ${projects.error.message}`}
            detail={projects.error.message}
            onRetry={() => projects.refetch()}
            retrying={projects.isFetching}
            className="justify-center"
          />
        </div>
      ) : projects.data.items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          没有你们都在的项目 🥔
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {projects.data.items.map((item) => (
            <li key={item.project.id}>
              <Link
                to="/projects/$slug"
                params={{ slug: item.project.slug }}
                className="flex items-center justify-between gap-2 px-3.5 py-2.5 transition-colors hover:bg-muted/50"
              >
                <span className="min-w-0 truncate font-medium">
                  {item.project.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.role}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
