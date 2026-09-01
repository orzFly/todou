import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { inboxQuery } from "@/api/inbox.ts";
import { projectsQuery } from "@/api/queries.ts";
import { type OrderedProject, useProjectOrder } from "@/api/useProjectOrder.ts";
import { projectTabs } from "@/components/project-nav.tsx";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnreadBadge } from "@/components/unread-badge.tsx";
import { cn } from "@/lib/utils";

/** Below this the search box is noise (T-76 design §3). */
const SEARCH_THRESHOLD = 8;

/**
 * Navbar project switcher (T-76). The project name keeps its link behavior;
 * this chevron alone opens the picker. A hand-rolled listbox (highlight via
 * aria-activedescendant, focus pinned on one element) instead of radix
 * DropdownMenu, whose typeahead would fight the embedded search input.
 */
export function ProjectSwitcher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const projects = useQuery(projectsQuery);
  const ordered = useProjectOrder(projects.data ?? []);

  // The shell keeps this query alive for the whole session, so subscribing
  // here costs no request — opening the picker never waits on the network,
  // and the per-row counts can never drift from the navbar badge they are
  // summed out of (T-202). Loading or failed inbox = empty map = no badges.
  const inbox = useQuery(inboxQuery);
  const unreadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of inbox.data?.items ?? []) {
      counts.set(item.project.slug, (counts.get(item.project.slug) ?? 0) + 1);
    }
    return counts;
  }, [inbox.data]);

  const showSearch = (projects.data?.length ?? 0) >= SEARCH_THRESHOLD;
  const q = query.trim().toLowerCase();
  const items = q
    ? ordered.filter(
        ({ project }) =>
          project.name.toLowerCase().includes(q) ||
          project.slug.toLowerCase().includes(q),
      )
    : ordered;

  // Clamp instead of resetting on every keystroke so the highlight tracks
  // the shrinking list without jumping to the top when it grows back.
  const hl = Math.min(highlight, Math.max(0, items.length - 1));

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${hl}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, hl]);

  // Keep the current nav module across the switch. Pages deeper than the nav
  // (issue detail, spec view) have no cross-project counterpart, so they fall
  // back to the list. Search params stay behind on purpose: another project's
  // filters rarely transfer. Resolved during render, not on click, because the
  // options are real links and need their href up front (T-117).
  const target =
    projectTabs.find((t) => matchRoute({ to: t.to }))?.to ?? "/projects/$slug";

  const openProject = (item: OrderedProject | undefined) => {
    if (!item) return;
    setOpen(false);
    navigate({ to: target, params: { slug: item.project.slug } });
  };

  // A modified click hands the link to the browser (new tab/window), so leave
  // the picker standing — the user is stacking tabs, not leaving this page.
  const closeUnlessNewTab = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setHighlight(Math.min(hl + 1, items.length - 1));
    else if (e.key === "ArrowUp") setHighlight(Math.max(hl - 1, 0));
    else if (e.key === "Home") setHighlight(0);
    else if (e.key === "End") setHighlight(Math.max(0, items.length - 1));
    else if (e.key === "Enter") openProject(items[hl]);
    else return;
    e.preventDefault();
  };

  const reset = (next: boolean) => {
    setOpen(next);
    setQuery("");
    setHighlight(0);
  };

  const activeId = items[hl]
    ? `project-option-${items[hl].project.slug}`
    : undefined;

  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground"
          aria-haspopup="listbox"
          aria-label="切换项目"
        >
          <ChevronsUpDownIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="flex w-75 max-w-[calc(100vw-2rem)] flex-col p-0"
        onKeyDown={onKeyDown}
        // The picker is keyboard-first: focus lands in the filter (or the
        // listbox) on open, not on radix's default first-focusable pick.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (showSearch ? inputRef : listRef).current?.focus();
        }}
      >
        {showSearch && (
          <div className="border-b p-2">
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls="project-switcher-list"
              aria-activedescendant={activeId}
              className="w-full bg-transparent px-1.5 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
              placeholder="搜索项目…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
            />
          </div>
        )}
        <div
          ref={listRef}
          id="project-switcher-list"
          role="listbox"
          aria-label="切换项目"
          // Focus stays here when there is no search box; activedescendant
          // does the walking either way, so options never need tabstops.
          tabIndex={showSearch ? -1 : 0}
          aria-activedescendant={showSearch ? undefined : activeId}
          className="max-h-80 overflow-y-auto p-1 outline-none"
        >
          {items.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              没有匹配的项目
            </div>
          ) : (
            items.map((item, idx) => {
              const count = unreadCounts.get(item.project.slug) ?? 0;
              return (
                // A link, not a div: middle-click, right-click → open in new
                // tab, ⌘/Ctrl-click and the status-bar URL preview all come
                // free, and role="option" keeps the listbox semantics intact
                // (T-117). tabIndex -1 because aria-activedescendant walks.
                <Link
                  key={item.project.slug}
                  to={target}
                  params={{ slug: item.project.slug }}
                  id={`project-option-${item.project.slug}`}
                  data-idx={idx}
                  role="option"
                  tabIndex={-1}
                  aria-selected={item.project.slug === slug}
                  // Only when there is something to announce: the badge is
                  // aria-hidden (a bare number reads as noise), and an
                  // unconditional label would put "— 0 未读" into every
                  // activedescendant announcement while arrowing the list.
                  aria-label={
                    count > 0
                      ? `${item.project.name} — ${count} 未读`
                      : undefined
                  }
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    idx === hl && "bg-accent",
                  )}
                  onMouseMove={() => setHighlight(idx)}
                  onClick={closeUnlessNewTab}
                >
                  <span className="w-3.5 shrink-0">
                    {item.project.slug === slug && (
                      <CheckIcon className="size-3.5" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "truncate",
                      item.neverVisited && "text-muted-foreground",
                    )}
                  >
                    {item.project.name}
                  </span>
                  <UnreadBadge count={count} className="ml-auto shrink-0" />
                </Link>
              );
            })
          )}
        </div>
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
