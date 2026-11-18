import type { Status } from "@todou/shared";
import { ChevronDownIcon, CircleDotIcon } from "lucide-react";
import { useBulkIssueMutation } from "@/api/issues.ts";
import {
  BULK_CHEVRON,
  BULK_TEXT,
  BulkButton,
} from "@/components/issue/bulk-button.tsx";
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
 * Moves a selection of cards to one status (T-707). Knows nothing about the
 * page holding the selection, so the board's can use it as the list's does.
 *
 * Not `StatusMenu`: that one marks the card's current status, and a selection
 * has none — it may span every status there is.
 */
export function BulkStatusMenu({
  slug,
  statuses,
  issueNumbers,
  onMoved,
}: {
  slug: string;
  statuses: readonly Status[];
  issueNumbers: readonly number[];
  /** Called as the move is sent, which is when a selection is spent. */
  onMoved?: () => void;
}) {
  const move = useBulkIssueStatus(slug, issueNumbers, onMoved);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <BulkButton
          label="Set status"
          icon={<CircleDotIcon />}
          disabled={issueNumbers.length === 0}
          data-testid="bulk-status-trigger"
        >
          <span className={BULK_TEXT}>Set status</span>
          <ChevronDownIcon className={BULK_CHEVRON} />
        </BulkButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-64">
        <BulkStatusItems statuses={statuses} onPick={move} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The status rows, shared with the overflow menu's submenu (T-775). */
export function BulkStatusItems({
  statuses,
  onPick,
}: {
  statuses: readonly Status[];
  onPick: (status: Status) => void;
}) {
  return statuses.map((s) => (
    <DropdownMenuItem
      key={s.id}
      className={cn(PICKER_ROW, "cursor-pointer")}
      onSelect={() => onPick(s)}
    >
      <StatusPill status={s} />
    </DropdownMenuItem>
  ));
}

export function useBulkIssueStatus(
  slug: string,
  issueNumbers: readonly number[],
  onMoved?: () => void,
): (status: Status) => void {
  const { mutate } = useBulkIssueMutation();
  return (status) => {
    mutate({
      slug,
      issueNumbers: [...issueNumbers],
      change: { kind: "status", status },
    });
    onMoved?.();
  };
}
