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
 * wide screens, on its own second row below `sm`, where it shares the row
 * with the search box.
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
    </nav>
  );
}

/**
 * Creating an issue, one click from every project module and absent exactly
 * where there is no project to file into (T-104). It sits in the header's
 * account cluster rather than at the end of the nav, so the search box comes
 * first and the nav's second row is left to the tabs and the box (T-215).
 *
 * Below `sm` the label goes and the icon stays: that row is the one where
 * the box has the least width to spare. aria-label rather than the visible
 * text, because a `display: none` label is not announced either.
 */
export function NewIssueButton({ slug }: { slug: string }) {
  return (
    <Button size="sm" asChild>
      <Link
        to="/projects/$slug/issues/new"
        params={{ slug }}
        aria-label="New issue"
      >
        <PlusIcon />
        <span className="hidden sm:inline">New issue</span>
      </Link>
    </Button>
  );
}
