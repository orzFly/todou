import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { projectsQuery } from "@/api/queries.ts";
import { userProjectsQuery } from "@/api/users.ts";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import {
  ProjectCard,
  ProjectCardGrid,
} from "@/components/shared/project-card.tsx";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ROLE_DOT } from "@/lib/roles.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";
import { cn } from "@/lib/utils";

/** Cards to occupy the grid while the seats load, at the height one holds. */
const SKELETONS = [0, 1, 2];

/**
 * Where this person holds a seat, and at what role (T-374) — narrowed to the
 * projects the reader can see, drawn on the projects home's own card (T-390).
 */
export function UserProjectsSection({ login }: { login: string }) {
  const projects = useQuery(userProjectsQuery(login));
  const items = projects.data?.items;
  // `useProjectRefs` memoizes on the array's identity, so a `map` taken fresh
  // per render would rematch the whole directory on every one of them.
  const seats = useMemo(() => items?.map((item) => item.project), [items]);
  const refs = useProjectRefs(seats);
  const descriptions = useProjectDescriptions();

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Ta 的项目</h2>
      {projects.isPending ? (
        <ProjectCardGrid>
          {SKELETONS.map((i) => (
            <Skeleton key={i} className="h-34" />
          ))}
        </ProjectCardGrid>
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
        <ProjectCardGrid>
          {projects.data.items.map((item) => {
            const description = descriptions.get(item.project.slug);
            return (
              <ProjectCard
                key={item.project.id}
                project={{
                  slug: item.project.slug,
                  name: item.project.name,
                  prefix: refs.get(item.project.slug)?.prefix ?? null,
                  icon_url: item.project.icon_url,
                }}
                badge={
                  <Badge variant="outline">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        ROLE_DOT[item.role],
                      )}
                      aria-hidden="true"
                    />
                    {item.role}
                  </Badge>
                }
              >
                {item.project.slug}
                {description ? ` — ${description}` : ""}
              </ProjectCard>
            );
          })}
        </ProjectCardGrid>
      )}
    </section>
  );
}

/**
 * Each readable project's description, by slug.
 *
 * `/users/<ref>/projects` answers with `ProjectBrief`s, which carry no
 * description, and giving them one is not an option: a `ProjectBrief` is
 * embedded in every row of the card list as well, so a description running to
 * 4000 characters would ride along with each row. What makes the join sound is
 * that the endpoint returns a subset of the reader's own readable projects —
 * the same membership query `listProjects` runs — so every seat shown here has
 * a row in the list the home page already reads. A slug that finds nothing
 * (the list is still loading, or failed) draws no description, the degrade the
 * watermark takes when the directory is away.
 *
 * `useQuery`, not the home's `useSuspenseQuery`: this is one supplementary
 * field, and a failing list must not drop the whole user page into an error
 * boundary.
 */
function useProjectDescriptions(): Map<string, string> {
  const projects = useQuery(projectsQuery);
  return useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.slug, p.description])),
    [projects.data],
  );
}
