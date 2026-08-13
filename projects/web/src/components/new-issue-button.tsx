import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { projectsQuery } from "@/api/queries.ts";
import { useProjectOrder } from "@/api/useProjectOrder.ts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const LABEL = "New issue";

/**
 * Navbar create entry (T-104). The label collapses to the bare icon below
 * `sm`, where the header already carries the project name and three other
 * controls.
 */
export function NewIssueButton() {
  const { slug } = useParams({ strict: false });
  return slug == null ? <PickingButton /> : <DirectButton slug={slug} />;
}

function Face() {
  return (
    <>
      <PlusIcon />
      <span className="max-sm:hidden">{LABEL}</span>
    </>
  );
}

function DirectButton({ slug }: { slug: string }) {
  return (
    <Button size="sm" asChild aria-label={LABEL} title={LABEL}>
      <Link to="/projects/$slug/issues/new" params={{ slug }}>
        <Face />
      </Link>
    </Button>
  );
}

/**
 * Off any project route (projects home, inbox, settings) an issue still
 * needs a project to land in. Asking beats picking the frecency winner
 * silently: filing into the wrong project costs far more than one click.
 */
function PickingButton() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" aria-label={LABEL} title={LABEL}>
          <Face />
        </Button>
      </DropdownMenuTrigger>
      {/* Radix leaves the content unmounted while closed, so the project
          list is only fetched once someone reaches for it. */}
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <ProjectChoices />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectChoices() {
  const projects = useQuery(projectsQuery);
  // Same frecency order as the switcher and the projects home (T-76).
  const ordered = useProjectOrder(projects.data ?? []);

  if (projects.isPending) {
    return <DropdownMenuItem disabled>Loading…</DropdownMenuItem>;
  }
  if (projects.isError) {
    return (
      <DropdownMenuItem disabled>Could not load projects</DropdownMenuItem>
    );
  }
  if (ordered.length === 0) {
    return (
      <DropdownMenuItem asChild>
        <Link to="/projects" search={{ new: true }}>
          + New project
        </Link>
      </DropdownMenuItem>
    );
  }
  return (
    <>
      <DropdownMenuLabel>New issue in…</DropdownMenuLabel>
      {ordered.map(({ project, neverVisited }) => (
        <DropdownMenuItem key={project.slug} asChild>
          <Link
            to="/projects/$slug/issues/new"
            params={{ slug: project.slug }}
            className={cn("truncate", neverVisited && "text-muted-foreground")}
          >
            {project.name}
          </Link>
        </DropdownMenuItem>
      ))}
    </>
  );
}
