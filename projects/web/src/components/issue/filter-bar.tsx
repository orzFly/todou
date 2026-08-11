import type { Label as LabelType, Member, Status } from "@todou/shared";
import { CheckIcon, FilterIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  csvToIds,
  type IssueSearch,
  idsToCsv,
  toggleId,
} from "@/api/issues.ts";
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

export function FilterBar({
  search,
  statuses,
  labels,
  members,
  onChange,
}: {
  search: IssueSearch;
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <SearchIcon className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search issues…"
          className="w-56 pl-8"
        />
      </div>

      <Select
        value={search.category ?? "all"}
        onValueChange={(v) =>
          onChange({
            ...search,
            category: v === "all" ? undefined : (v as "open" | "closed"),
          })
        }
      >
        <SelectTrigger className="w-28" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="open">Open</SelectItem>
          <SelectItem value="closed">Closed</SelectItem>
        </SelectContent>
      </Select>

      <MultiPick
        label="Status"
        items={statuses.map((s) => ({ id: s.id, name: s.name }))}
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
        items={labels.map((l) => ({ id: l.id, name: l.name }))}
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
          <SelectValue placeholder="Assignee" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="anyone">Any assignee</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.user.id} value={String(m.user.id)}>
              {m.user.login}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={`${search.sort ?? "created"}-${search.order ?? "desc"}`}
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
  items: Array<{ id: number; name: string }>;
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
            {item.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
