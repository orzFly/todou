import type {
  IssueCounts,
  Label as LabelType,
  Member,
  Status,
} from "@todou/shared";
import {
  CheckCircle2Icon,
  CheckIcon,
  CircleDotIcon,
  FilterIcon,
  Rows3Icon,
  SearchIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  csvToIds,
  effectiveCategory,
  effectiveGroup,
  effectiveSort,
  type IssueSearch,
  idsToCsv,
  toggleId,
} from "@/api/issues.ts";
import { LabelInline } from "@/components/issue/label-chip.tsx";
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function FilterBar({
  search,
  counts,
  statuses,
  labels,
  members,
  onChange,
}: {
  search: IssueSearch;
  counts: IssueCounts;
  statuses: Status[];
  labels: LabelType[];
  members: Member[];
  onChange: (next: IssueSearch) => void;
}) {
  const [q, setQ] = useState(search.q ?? "");
  // Debounce free-text search into the URL.
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = q.trim() === "" ? undefined : q.trim();
      if (next !== search.q) onChange({ ...search, q: next });
    }, 300);
    return () => clearTimeout(handle);
  }, [q, search, onChange]);

  const selectedStatuses = csvToIds(search.status) ?? [];
  const selectedLabels = csvToIds(search.label) ?? [];
  const selectedAssignee = members.find((m) => m.user.id === search.assignee);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CategorySegment
        counts={counts}
        active={effectiveCategory(search)}
        onSelect={(category) =>
          onChange({
            ...search,
            // Open is the default, so it maps to a clean URL.
            category: category === "open" ? undefined : category,
          })
        }
      />

      <div className="relative">
        <SearchIcon className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search issues…"
          className="w-56 pl-8"
        />
      </div>

      <MultiPick
        label="Status"
        items={statuses.map((s) => ({
          id: s.id,
          node: (
            <>
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              {s.name}
            </>
          ),
        }))}
        selected={selectedStatuses}
        onToggle={(id) =>
          onChange({
            ...search,
            status: idsToCsv(toggleId(selectedStatuses, id)),
          })
        }
      />

      <MultiPick
        label="Labels"
        items={labels.map((l) => ({
          id: l.id,
          node: <LabelInline label={l} />,
        }))}
        selected={selectedLabels}
        onToggle={(id) =>
          onChange({ ...search, label: idsToCsv(toggleId(selectedLabels, id)) })
        }
      />

      <Select
        value={
          search.assignee === undefined ? "anyone" : String(search.assignee)
        }
        onValueChange={(v) =>
          onChange({
            ...search,
            assignee: v === "anyone" ? undefined : Number(v),
          })
        }
      >
        <SelectTrigger className="w-36" size="sm">
          {/* Naming the value here rather than letting the trigger echo the
              selected item: the item carries `@login` for disambiguation,
              and this narrow trigger would clip it to a bare "@". */}
          <SelectValue placeholder="Assignee">
            {selectedAssignee === undefined
              ? "Any assignee"
              : displayNameOf(selectedAssignee.user)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="anyone">Any assignee</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.user.id} value={String(m.user.id)}>
              {displayNameOf(m.user)}
              <span className="text-muted-foreground">@{m.user.login}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={`${effectiveSort(search).sort}-${effectiveSort(search).order}`}
        onValueChange={(v) => {
          const [sort, order] = v.split("-") as [
            IssueSearch["sort"],
            IssueSearch["order"],
          ];
          onChange({ ...search, sort, order });
        }}
      >
        <SelectTrigger className="w-40" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="created-desc">Newest</SelectItem>
          <SelectItem value="created-asc">Oldest</SelectItem>
          <SelectItem value="updated-desc">Recently updated</SelectItem>
          <SelectItem value="number-asc">Number ↑</SelectItem>
          <SelectItem value="number-desc">Number ↓</SelectItem>
        </SelectContent>
      </Select>

      {/* Grouping only exists in the open-category view (T-88). */}
      {effectiveCategory(search) === "open" && (
        <Button
          variant="outline"
          size="sm"
          aria-pressed={effectiveGroup(search) === "status"}
          className={cn(
            effectiveGroup(search) === "status" &&
              "bg-muted font-semibold hover:bg-muted",
          )}
          onClick={() =>
            onChange({
              ...search,
              group: effectiveGroup(search) === "status" ? "none" : undefined,
            })
          }
        >
          <Rows3Icon className="size-3.5" />
          Grouped
        </Button>
      )}
    </div>
  );
}

/**
 * Open/Closed/All in the toolbar itself, replacing the tabs row above the
 * list and the old category dropdown — the toolbar floats, and the category
 * switch must float with it (T-88).
 */
function CategorySegment({
  counts,
  active,
  onSelect,
}: {
  counts: IssueCounts;
  active: "open" | "closed" | "all";
  onSelect: (category: "open" | "closed" | "all") => void;
}) {
  const seg = (selected: boolean) =>
    cn(
      "flex h-8 cursor-pointer items-center gap-1.5 border-l px-2.5 text-sm first:border-l-0",
      selected
        ? "bg-muted font-semibold text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="inline-flex overflow-hidden rounded-md border">
      <button
        type="button"
        className={seg(active === "open")}
        onClick={() => onSelect("open")}
      >
        <CircleDotIcon className="size-4" />
        Open {counts.open}
      </button>
      <button
        type="button"
        className={seg(active === "closed")}
        onClick={() => onSelect("closed")}
      >
        <CheckCircle2Icon className="size-4" />
        Closed {counts.closed}
      </button>
      <button
        type="button"
        className={seg(active === "all")}
        onClick={() => onSelect("all")}
      >
        All
      </button>
    </div>
  );
}

function MultiPick({
  label,
  items,
  selected,
  onToggle,
}: {
  label: string;
  items: Array<{ id: number; node: ReactNode }>;
  selected: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <FilterIcon className="size-3.5" />
          {label}
          {selected.length > 0 && ` (${selected.length})`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 && (
          <DropdownMenuItem disabled>None defined</DropdownMenuItem>
        )}
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={(e) => {
              e.preventDefault();
              onToggle(item.id);
            }}
          >
            <span className="w-4">
              {selected.includes(item.id) && <CheckIcon className="size-4" />}
            </span>
            {item.node}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
