import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Shared with the project switcher, which keeps the active tab across a switch. */
export const projectTabs = [
  { to: "/projects/$slug", label: "List", exact: true },
  { to: "/projects/$slug/board", label: "Board", exact: false },
  { to: "/projects/$slug/settings", label: "Settings", exact: false },
] as const;

/**
 * Project-level navigation (T-62). Lives in the floating header: inline on
 * wide screens, on its own second row below `sm`. Creating an issue rides
 * along at the far end, so it is one click from every project module and
 * absent exactly where there is no project to file into (T-104).
 */
export function ProjectNav({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  return (
    // nowrap so a squeezed header truncates the project name instead of
    // wrapping the tabs, which would push the create button off its row.
    <nav className={cn("flex items-center gap-1 whitespace-nowrap", className)}>
      {projectTabs.map((tab) => (
        <Link
          key={tab.label}
          to={tab.to}
          params={{ slug }}
          // includeSearch off: exact mode deep-equals the whole search object,
          // so filter params like ?category=closed would drop the highlight (T-79).
          activeOptions={{ exact: tab.exact, includeSearch: false }}
          className="rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
          activeProps={{
            className: "bg-accent text-foreground font-medium",
          }}
        >
          {tab.label}
        </Link>
      ))}
      {/* The caller stretches the nav across the row, so this keeps the
          right-edge position it held while it lived in the header cluster. */}
      <Button size="sm" asChild className="ml-auto">
        <Link to="/projects/$slug/issues/new" params={{ slug }}>
          <PlusIcon />
          New issue
        </Link>
      </Button>
    </nav>
  );
}
