import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { inboxQuery, unreadCounts } from "@/api/inbox.ts";
import { projectsQuery } from "@/api/queries.ts";
import { useProjectOrder } from "@/api/useProjectOrder.ts";
import {
  ProjectListbox,
  type ProjectListboxHandle,
  type ProjectListboxOption,
} from "@/components/project-listbox.tsx";
import { projectTabs } from "@/components/project-nav.tsx";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnreadBadge } from "@/components/unread-badge.tsx";

/**
 * Navbar project switcher (T-76). The project name keeps its link behavior;
 * this chevron alone opens the picker. A hand-rolled listbox rather than a
 * radix DropdownMenu, whose typeahead would fight the embedded search input.
 */
export function ProjectSwitcher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const listbox = useRef<ProjectListboxHandle>(null);

  const projects = useQuery(projectsQuery);
  const ordered = useProjectOrder(projects.data ?? []);

  // The shell keeps this query alive for the whole session, so subscribing
  // here costs no request — opening the picker never waits on the network,
  // and the per-row counts can never drift from the navbar badge they are
  // summed out of (T-202). Loading or failed inbox = empty map = no badges.
  const inbox = useQuery(inboxQuery);
  const counts = unreadCounts(inbox.data);

  // Keep the current nav module across the switch. Pages deeper than the nav
  // (issue detail, spec view) have no cross-project counterpart, so they fall
  // back to the list. Search params stay behind on purpose: another project's
  // filters rarely transfer. Resolved during render, not on click, because the
  // options are real links and need their href up front (T-117).
  const target =
    projectTabs.find((t) => matchRoute({ to: t.to }))?.to ?? "/projects/$slug";

  const options = useMemo<ProjectListboxOption[]>(
    () =>
      ordered.map((item) => {
        const count = counts[item.project.slug] ?? 0;
        return {
          project: item.project,
          link: { to: target, params: { slug: item.project.slug } },
          muted: item.neverVisited,
          // The spelling token ahead of it already takes the free space.
          trailing: <UnreadBadge count={count} className="shrink-0" />,
          // Only when there is something to announce: the badge is
          // aria-hidden (a bare number reads as noise), and an unconditional
          // label would put "— 0 unread" into every activedescendant
          // announcement while arrowing the list.
          ariaLabel:
            count > 0 ? `${item.project.name} — ${count} unread` : undefined,
        };
      }),
    [ordered, counts, target],
  );

  // A modified click hands the link to the browser (new tab/window), so leave
  // the picker standing — the user is stacking tabs, not leaving this page.
  const closeUnlessNewTab = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground"
          aria-haspopup="listbox"
          aria-label="Switch project"
        >
          <ChevronsUpDownIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="flex w-75 max-w-[calc(100vw-2rem)] flex-col p-0"
        // The picker is keyboard-first: focus lands in the filter (or the
        // listbox) on open, not on radix's default first-focusable pick.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          listbox.current?.focus();
        }}
      >
        <ProjectListbox
          ref={listbox}
          options={options}
          selected={slug}
          label="Switch project"
          idPrefix="project-option"
          searchPlaceholder="Search projects…"
          emptyText="No projects match"
          className="flex min-h-0 flex-col"
          onSelect={(option) => {
            setOpen(false);
            navigate({ to: target, params: { slug: option.project.slug } });
          }}
          onLinkClick={closeUnlessNewTab}
        />
        <div className="flex border-t p-1">
          <Link
            to="/projects"
            onClick={closeUnlessNewTab}
            className="flex-1 rounded-md px-2 py-1.5 text-center text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            All projects
          </Link>
          <Link
            to="/projects"
            search={{ new: true }}
            onClick={closeUnlessNewTab}
            className="flex-1 rounded-md px-2 py-1.5 text-center text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            + New project
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
