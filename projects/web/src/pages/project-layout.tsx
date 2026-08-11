import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { projectQuery } from "@/api/queries.ts";
import { useProjectEvents } from "@/api/useProjectEvents.ts";
import { cn } from "@/lib/utils";

const tabs = [
  { to: "/projects/$slug", label: "List", exact: true },
  { to: "/projects/$slug/board", label: "Board", exact: false },
  { to: "/projects/$slug/settings", label: "Settings", exact: false },
] as const;

export function ProjectLayout() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const project = useSuspenseQuery(projectQuery(slug));
  // Live updates for every page under this project (list/board/issue).
  useProjectEvents(slug);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{project.data.name}</h1>
          {project.data.description && (
            <p className="text-sm text-muted-foreground">
              {project.data.description}
            </p>
          )}
        </div>
        <nav className="flex gap-1 rounded-lg border p-1">
          {tabs.map((tab) => (
            <Link
              key={tab.label}
              to={tab.to}
              params={{ slug }}
              activeOptions={{ exact: tab.exact }}
              className={cn(
                "rounded-md px-3 py-1 text-sm text-muted-foreground",
                "hover:text-foreground",
              )}
              activeProps={{
                className: "bg-accent text-foreground font-medium",
              }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
