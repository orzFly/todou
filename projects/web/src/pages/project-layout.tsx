import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { projectQuery } from "@/api/queries.ts";
import { useProjectEvents } from "@/api/useProjectEvents.ts";

export function ProjectLayout() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const project = useSuspenseQuery(projectQuery(slug));
  // Live updates for every page under this project (list/board/issue).
  useProjectEvents(slug);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">
          <Link
            to="/projects/$slug"
            params={{ slug }}
            className="hover:underline"
          >
            {project.data.name}
          </Link>
        </h1>
        {project.data.description && (
          <p className="text-sm text-muted-foreground">
            {project.data.description}
          </p>
        )}
      </div>
      <Outlet />
    </div>
  );
}
