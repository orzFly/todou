import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const tabs = [
  { to: "/projects/$slug", label: "List", exact: true },
  { to: "/projects/$slug/board", label: "Board", exact: false },
  { to: "/projects/$slug/settings", label: "Settings", exact: false },
] as const;

/**
 * Project-level navigation (#62). Lives in the floating header: inline on
 * wide screens, on its own second row below `sm`.
 */
export function ProjectNav({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  return (
    <nav className={cn("flex gap-1", className)}>
      {tabs.map((tab) => (
        <Link
          key={tab.label}
          to={tab.to}
          params={{ slug }}
          activeOptions={{ exact: tab.exact }}
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
