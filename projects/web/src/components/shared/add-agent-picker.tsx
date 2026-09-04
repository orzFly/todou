import type { Agent } from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Picks an agent to add to a project (T-228). A hand-rolled listbox — highlight
 * via aria-activedescendant, focus pinned on the input — instead of radix
 * DropdownMenu, whose typeahead would fight the embedded search box.
 *
 * The candidate filtering lives here rather than in the caller so the component
 * can tell "you own no agents" (render nothing) apart from "they are all
 * members already" (say so), which are different things to say.
 */
export function AddAgentPicker({
  agents,
  memberIds,
  onAdd,
  busy = false,
  defaultOpen = false,
}: {
  /** Every agent the viewer owns, unfiltered. */
  agents: Agent[];
  /** User ids already on the project. */
  memberIds: ReadonlySet<number>;
  onAdd: (agent: Agent) => void;
  /** A membership write is in flight: grey the list out and swallow clicks. */
  busy?: boolean;
  /** Test-only, as on LabelPicker. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // listAgents has no ORDER BY, so without this the rows come back in whatever
  // order the database felt like.
  const candidates = agents
    .filter((a) => !memberIds.has(a.id) && a.disabled_at === null)
    .sort((a, b) => displayNameOf(a).localeCompare(displayNameOf(b)));

  const q = query.trim().toLowerCase();
  const items = q
    ? candidates.filter(
        (a) =>
          displayNameOf(a).toLowerCase().includes(q) ||
          a.login.toLowerCase().includes(q),
      )
    : candidates;

  // Clamped, not just reset on keystroke: adding an agent invalidates the
  // member list, which pulls that row out from under a highlight nobody moved.
  const hl = Math.min(highlight, Math.max(0, items.length - 1));
  const activeId = items[hl] ? `add-agent-option-${items[hl].id}` : undefined;

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${hl}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, hl]);

  const pick = (agent: Agent | undefined) => {
    if (busy || !agent) return;
    onAdd(agent);
    setQuery("");
    setHighlight(0);
    // The popover stays open on purpose: whoever needs a search box here has
    // enough agents that they are likely adding more than one.
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setHighlight(Math.min(hl + 1, items.length - 1));
    else if (e.key === "ArrowUp") setHighlight(Math.max(hl - 1, 0));
    else if (e.key === "Home") setHighlight(0);
    else if (e.key === "End") setHighlight(Math.max(0, items.length - 1));
    else if (e.key === "Enter") pick(items[hl]);
    // Escape falls through to radix, which closes the popover with it.
    else return;
    e.preventDefault();
  };

  const reset = (next: boolean) => {
    setOpen(next);
    setQuery("");
    setHighlight(0);
  };

  if (agents.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={reset}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-haspopup="listbox">
          <PlusIcon className="size-3.5" /> Add agent
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-0"
        onKeyDown={onKeyDown}
        // Keyboard-first: focus lands in the filter, not on radix's default
        // first-focusable pick.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="add-agent-list"
          aria-activedescendant={activeId}
          aria-label="filter agents"
          placeholder="Filter agents…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          // text-base below md: sub-16px inputs trigger iOS focus auto-zoom.
          className="w-full border-b bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <div
          ref={listRef}
          id="add-agent-list"
          role="listbox"
          aria-label="agents"
          className="max-h-64 overflow-y-auto p-1"
        >
          {items.map((agent, idx) => (
            <button
              type="button"
              key={agent.id}
              id={`add-agent-option-${agent.id}`}
              data-idx={idx}
              role="option"
              aria-selected={false}
              tabIndex={-1}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                idx === hl && "bg-accent",
                busy && "opacity-50",
              )}
              // onMouseMove, not onMouseEnter: a list scrolling under a still
              // cursor would otherwise steal the highlight.
              onMouseMove={() => setHighlight(idx)}
              onClick={() => pick(agent)}
            >
              {/* Decorative: the initials fallback would otherwise be read out
                  glued to the name this row already carries. */}
              <UserAvatar user={agent} aria-hidden />
              <span className="min-w-0 truncate">{displayNameOf(agent)}</span>
              <span className="min-w-0 truncate text-muted-foreground">
                @{agent.login}
              </span>
            </button>
          ))}
          {items.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              {candidates.length === 0
                ? "Every agent you own is already a member."
                : "No matching agent."}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
