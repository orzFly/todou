import type { Status } from "@todou/shared";
import { CheckIcon } from "lucide-react";
import { PICKER_ROW } from "@/components/issue/picker-row.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A status pill that opens the project's statuses — the sidebar's and a
 * row's alike. Without `onStatus` it stays the bare pill: below
 * `issue.triage`, or on a trashed card, there is nothing to open that the
 * server would not refuse.
 *
 * Sized and laid out like the Labels and Assignees pickers it sits beside
 * (T-719): the shared menu default is the trigger's width, which for a pill
 * is narrower than "Ready to Ship".
 */
export function StatusMenu({
  status,
  statuses,
  onStatus,
}: {
  status: Status;
  statuses: readonly Status[];
  onStatus?: (status: Status) => void;
}) {
  if (!onStatus) return <StatusPill status={status} />;
  return (
    <DropdownMenu>
      {/* flex collapses the button's line box to the pill; the default
          block box is 24px tall and seats the pill on its text baseline,
          ~1.6px below the neighbouring label chips (T-98). w-fit keeps the
          hit area to the pill where the parent is a block. */}
      <DropdownMenuTrigger className="flex w-fit cursor-pointer">
        <StatusPill status={status} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-64">
        {statuses.map((s) => (
          <DropdownMenuItem
            key={s.id}
            className={cn(PICKER_ROW, "cursor-pointer")}
            onSelect={() => onStatus(s)}
          >
            <StatusPill status={s} />
            <span className="ml-auto w-4 shrink-0">
              {s.id === status.id && <CheckIcon className="size-4" />}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
