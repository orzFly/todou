import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { Label } from "@todou/shared";
import { CheckIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { api, membersQuery, meQuery } from "@/api/queries.ts";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  canonicalizeLabelName,
  labelColorFor,
  labelNearKey,
  splitLabelName,
} from "@/lib/labels.ts";
import { cn } from "@/lib/utils";

/** Label creation is admin-only server-side; the UI hides the affordance. */
export function useCanCreateLabels(slug: string): boolean {
  const me = useSuspenseQuery(meQuery);
  const members = useSuspenseQuery(membersQuery(slug));
  return members.data.some(
    (m) => m.user.id === me.data.id && m.role === "admin",
  );
}

/** The onCreate implementation shared by all picker call sites. */
export function useCreateLabel(slug: string): (name: string) => Promise<Label> {
  const queryClient = useQueryClient();
  return async (name: string) => {
    try {
      const label = await api.createLabel(slug, {
        name,
        color: labelColorFor(name),
      });
      queryClient.invalidateQueries({ queryKey: ["labels", slug] });
      return label;
    } catch (error) {
      toast.error(`Could not create label: ${(error as Error).message}`);
      throw error;
    }
  };
}

/** A label rendered the grouped way inside menu rows: muted prefix outside,
 *  value-only tinted badge. */
function MenuRowLabel({ label }: { label: Label }) {
  const { prefix } = splitLabelName(label.name);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {prefix && (
        <span className="text-xs text-muted-foreground">{prefix}</span>
      )}
      <LabelChip label={label} valueOnly bordered={false} />
    </span>
  );
}

type PickerRow =
  | { kind: "toggle"; label: Label }
  | { kind: "create"; name: string };

/**
 * Chip-input label picker: filter case-insensitively, apply labels, and (for
 * admins) create missing ones in place. Near-duplicates — names differing
 * only in case or whitespace — surface a warning instead of a create row, so
 * "Area: Web" never silently lands next to "area:web".
 */
export function LabelPicker({
  allLabels,
  selected,
  onToggle,
  onCreate,
  trigger,
  defaultOpen = false,
}: {
  allLabels: Label[];
  selected: Label[];
  onToggle: (label: Label) => void;
  onCreate?: (name: string) => Promise<Label>;
  trigger: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);

  const canonical = canonicalizeLabelName(query);
  const q = canonical.toLowerCase();
  const matches = allLabels.filter((l) => l.name.toLowerCase().includes(q));
  const near =
    canonical === ""
      ? undefined
      : allLabels.find((l) => labelNearKey(l.name) === labelNearKey(canonical));
  const nearMismatch = near !== undefined && near.name !== canonical;

  const rows: PickerRow[] = matches.map((label) => ({
    kind: "toggle",
    label,
  }));
  if (canonical !== "" && near === undefined && onCreate !== undefined) {
    if (!canonical.includes(":")) {
      const prefixes = new Set(
        allLabels
          .map((l) => splitLabelName(l.name).prefix)
          .filter((p): p is string => p !== null),
      );
      for (const prefix of prefixes) {
        const name = prefix + canonical;
        if (allLabels.some((l) => labelNearKey(l.name) === labelNearKey(name)))
          continue;
        rows.push({ kind: "create", name });
      }
    }
    rows.push({ kind: "create", name: canonical });
  }

  const isSelected = (label: Label) => selected.some((s) => s.id === label.id);

  async function pick(row: PickerRow) {
    if (creating) return;
    if (row.kind === "toggle") {
      onToggle(row.label);
      return;
    }
    setCreating(true);
    try {
      const created = await onCreate?.(row.name);
      if (created) {
        onToggle(created);
        setQuery("");
        setHighlight(0);
      }
    } catch {
      // useCreateLabel already toasted; keep the query for a retry.
    } finally {
      setCreating(false);
    }
  }

  function applyNear() {
    if (!near) return;
    if (!isSelected(near)) onToggle(near);
    setQuery("");
    setHighlight(0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) =>
        rows.length === 0 ? 0 : (h + delta + rows.length) % rows.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      // With a near-duplicate warning up, Enter means "use the existing one".
      if (nearMismatch) applyNear();
      else if (rows[highlight]) void pick(rows[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setHighlight(0);
        }
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b p-2">
            {selected.map((label) => {
              const { prefix } = splitLabelName(label.name);
              return (
                <span key={label.id} className="inline-flex items-center gap-1">
                  {prefix && (
                    <span className="text-xs text-muted-foreground">
                      {prefix}
                    </span>
                  )}
                  <LabelChip label={label} valueOnly />
                  <button
                    type="button"
                    aria-label={`remove ${label.name}`}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => onToggle(label)}
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={onCreate ? "Filter or create labels…" : "Filter labels…"}
          aria-label="filter labels"
          // text-base below md: sub-16px inputs trigger iOS focus auto-zoom.
          className="w-full border-b bg-transparent px-3 py-2 text-base outline-none md:text-sm"
        />
        {nearMismatch && (
          <div className="m-2 flex flex-wrap items-center gap-1 rounded-md border border-amber-500/60 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            Similar label exists
            <MenuRowLabel label={near} />—
            <button
              type="button"
              className="cursor-pointer font-semibold underline"
              onClick={applyNear}
            >
              use it
            </button>
            {onCreate && (
              <button
                type="button"
                className="cursor-pointer text-amber-700/75 underline dark:text-amber-400/75"
                disabled={creating}
                onClick={() => void pick({ kind: "create", name: canonical })}
              >
                create “{canonical}” anyway
              </button>
            )}
          </div>
        )}
        <div
          role="listbox"
          aria-label="labels"
          className="max-h-64 overflow-y-auto p-1"
        >
          {rows.map((row, index) => (
            <button
              type="button"
              key={row.kind === "toggle" ? `l${row.label.id}` : `c${row.name}`}
              role="option"
              aria-selected={row.kind === "toggle" && isSelected(row.label)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                index === highlight && "bg-accent",
                creating && "opacity-50",
              )}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => void pick(row)}
            >
              {row.kind === "toggle" ? (
                <>
                  <span className="w-4 shrink-0">
                    {isSelected(row.label) && <CheckIcon className="size-4" />}
                  </span>
                  <MenuRowLabel label={row.label} />
                </>
              ) : (
                <>
                  <span
                    className="ml-1 size-3 shrink-0 rounded-full"
                    style={{ backgroundColor: labelColorFor(row.name) }}
                    aria-hidden
                  />
                  <span className="min-w-0 truncate">Create “{row.name}”</span>
                </>
              )}
            </button>
          ))}
          {rows.length === 0 && !nearMismatch && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              {allLabels.length === 0 && query === ""
                ? "No labels defined"
                : "No matching labels"}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
