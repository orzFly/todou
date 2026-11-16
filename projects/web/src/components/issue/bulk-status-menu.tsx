import type { Status } from "@todou/shared";
import { ChevronDownIcon } from "lucide-react";
import { useBulkIssueStatusMutation } from "@/api/issues.ts";
import { PICKER_ROW } from "@/components/issue/picker-row.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { Button } from "@/components/ui/button";
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
  const move = useBulkIssueStatusMutation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={issueNumbers.length === 0}
          data-testid="bulk-status-trigger"
        >
          Set status
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-64">
        {statuses.map((s) => (
          <DropdownMenuItem
            key={s.id}
            className={cn(PICKER_ROW, "cursor-pointer")}
            onSelect={() => {
              move.mutate({ slug, issueNumbers: [...issueNumbers], status: s });
              onMoved?.();
            }}
          >
            <StatusPill status={s} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
