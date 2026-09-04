import type { Project } from "@todou/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Below this the search box is noise (matches the navbar switcher). */
const SEARCH_THRESHOLD = 8;

/**
 * Pick a project and hand it back — the choosing half of the navbar
 * switcher, without its navigation.
 *
 * The options here are buttons rather than links on purpose: the switcher's
 * options are destinations, so they must be anchors; this one names an
 * argument to a form the user has not submitted yet, and there is nowhere
 * for a middle-click to go.
 */
export function ProjectPicker({
  projects,
  selected,
  onSelect,
  label,
}: {
  projects: Project[];
  selected?: string;
  onSelect: (project: Project) => void;
  label: string;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const items = useMemo(
    () =>
      q === ""
        ? projects
        : projects.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.slug.toLowerCase().includes(q),
          ),
    [projects, q],
  );

  // Clamped rather than reset per keystroke, so the highlight tracks a
  // shrinking list without jumping to the top when it grows back.
  const hl = Math.min(highlight, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${hl}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [hl]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setHighlight(Math.min(hl + 1, items.length - 1));
    else if (e.key === "ArrowUp") setHighlight(Math.max(hl - 1, 0));
    else if (e.key === "Home") setHighlight(0);
    else if (e.key === "End") setHighlight(Math.max(0, items.length - 1));
    else if (e.key === "Enter") {
      const item = items[hl];
      if (item) onSelect(item);
    } else return;
    e.preventDefault();
  };

  const showSearch = projects.length >= SEARCH_THRESHOLD;
  const activeId = items[hl] ? `pick-${items[hl].slug}` : undefined;

  return (
    <div className="rounded-md border">
      {showSearch && (
        <div className="border-b p-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog opens on this step
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="project-picker-list"
            aria-activedescendant={activeId}
            className="w-full bg-transparent px-1.5 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search projects…"
            value={query}
            onKeyDown={onKeyDown}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
          />
        </div>
      )}
      <div
        ref={listRef}
        id="project-picker-list"
        role="listbox"
        aria-label={label}
        tabIndex={showSearch ? -1 : 0}
        aria-activedescendant={showSearch ? undefined : activeId}
        onKeyDown={onKeyDown}
        className="max-h-64 overflow-y-auto p-1 outline-none"
      >
        {items.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No project to move this into.
          </div>
        ) : (
          items.map((project, idx) => (
            <button
              key={project.slug}
              type="button"
              id={`pick-${project.slug}`}
              data-idx={idx}
              role="option"
              tabIndex={-1}
              aria-selected={project.slug === selected}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                idx === hl && "bg-accent",
              )}
              onMouseMove={() => setHighlight(idx)}
              onClick={() => onSelect(project)}
            >
              <span className="truncate">{project.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {project.slug}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
