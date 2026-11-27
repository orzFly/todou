import { Button } from "@orz/ui/components/button";
import { FilterMenu } from "@orz/ui/components/filter-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@orz/ui/components/tooltip";
import { isPlainClick } from "@orz/ui/lib/link";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Project } from "@todou/shared";
import { ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { type MouseEvent, useMemo, useState } from "react";
import { inboxQuery, unreadCounts } from "@/api/inbox.ts";
import { projectsQuery } from "@/api/queries.ts";
import { useProjectOrder } from "@/api/useProjectOrder.ts";
import { projectTabs } from "@/components/project-nav.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { ProjectRow } from "@/components/shared/project-row.tsx";
import { UnreadBadge } from "@/components/unread-badge.tsx";
import { useNavCurrent } from "@/lib/nav-current.ts";
import { matchProject, type ProjectMatch } from "@/lib/project-match.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";

interface SwitcherRow {
  /** The slug: unique, and what `selectedId` names. */
  id: string;
  project: Project;
  match: ProjectMatch | null;
  prefix: string | null;
  muted: boolean;
  count: number;
}

/**
 * Navbar project switcher (T-76). The project name keeps its link behaviour;
 * this chevron alone opens the picker. Every row is a link to the same module
 * of another project, so a middle click opens it in a tab (T-117).
 */
export function ProjectSwitcher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = useNavCurrent();

  const projects = useQuery(projectsQuery);
  const ordered = useProjectOrder(projects.data ?? []);
  const all = useMemo(() => ordered.map((item) => item.project), [ordered]);
  // Not `matchText`: a project is also found by its REF prefix.
  const refs = useProjectRefs(all);

  // The shell keeps this query alive for the whole session, so subscribing
  // here costs no request — opening the picker never waits on the network,
  // and the per-row counts can never drift from the navbar badge they are
  // summed out of (T-202). Loading or failed inbox = empty map = no badges.
  const inbox = useQuery(inboxQuery);
  const counts = unreadCounts(inbox.data);

  // The module the tabs mark, so a switch lands where the reader was. Pages
  // no tab marks (issue detail, spec view) have no cross-project counterpart
  // and fall back to the list. Search params stay behind on purpose: another
  // project's filters rarely transfer. Resolved during render, not on click,
  // because the rows are real links and need their href up front (T-117).
  const target =
    projectTabs.find((tab) => current({ ...tab, params: { slug } }) !== false)
      ?.to ?? "/projects/$slug";

  const q = query.trim().toLowerCase();
  const rows = useMemo<SwitcherRow[]>(() => {
    const out: SwitcherRow[] = [];
    for (const item of ordered) {
      const prefix = refs.get(item.project.slug)?.prefix ?? null;
      const match =
        q === ""
          ? null
          : matchProject(
              { name: item.project.name, slug: item.project.slug, prefix },
              q,
            );
      if (q !== "" && match === null) continue;
      out.push({
        id: item.project.slug,
        project: item.project,
        match,
        prefix,
        muted: item.neverVisited,
        count: counts[item.project.slug] ?? 0,
      });
    }
    return out;
  }, [ordered, refs, q, counts]);

  // A modified click hands the link to the browser (new tab/window), so leave
  // the picker standing — the user is stacking tabs, not leaving this page.
  const closeOnPlainClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isPlainClick(event)) setOpen(false);
  };

  return (
    <Tooltip>
      <FilterMenu
        open={open}
        onOpenChange={setOpen}
        query={query}
        onQueryChange={setQuery}
        sections={[{ id: "projects", rows }]}
        selectedId={slug}
        rowLink={(row) => (
          <Link
            to={target}
            params={{ slug: row.id }}
            // Only when there is something to announce: the badge is
            // aria-hidden (a bare number reads as noise), and an
            // unconditional label would put "— 0 unread" into every
            // activedescendant announcement while arrowing the list.
            aria-label={
              row.count > 0
                ? `${row.project.name} — ${row.count} unread`
                : undefined
            }
          />
        )}
        renderRow={(row) => (
          <ProjectRow
            project={{
              name: row.project.name,
              slug: row.project.slug,
              prefix: row.prefix,
            }}
            match={row.match}
            muted={row.muted}
            icon={
              <ProjectIcon
                aria-hidden="true"
                project={{
                  slug: row.project.slug,
                  name: row.project.name,
                  prefix: row.prefix,
                  icon_url: row.project.icon_url,
                }}
                className="size-5"
              />
            }
            // The spelling token ahead of it already takes the free space.
            trailing={<UnreadBadge count={row.count} className="shrink-0" />}
          />
        )}
        placeholder="Search projects…"
        inputLabel="Search projects"
        listLabel="Projects"
        empty={() => "No projects match"}
        className="w-75 max-w-[calc(100vw-2rem)]"
        footer={
          // Exact, or every project page would mark "All projects" as the
          // page the reader is on: it is a prefix of all of them.
          <div className="flex gap-1 border-t p-1">
            <Button variant="ghost" size="sm" asChild className="flex-1">
              <Link
                to="/projects"
                activeOptions={{ exact: true }}
                onClick={closeOnPlainClick}
              >
                All projects
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild className="flex-1">
              <Link
                to="/projects"
                search={{ new: true }}
                activeOptions={{ exact: true }}
                onClick={closeOnPlainClick}
              >
                <PlusIcon />
                New project
              </Link>
            </Button>
          </div>
        }
      >
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            aria-label="Switch project"
          >
            <ChevronsUpDownIcon />
          </Button>
        </TooltipTrigger>
      </FilterMenu>
      <TooltipContent>Switch project</TooltipContent>
    </Tooltip>
  );
}
