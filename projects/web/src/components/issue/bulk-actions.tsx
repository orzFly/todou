import { Button } from "@orz/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@orz/ui/components/dropdown-menu";
import type { Status } from "@todou/shared";
import {
  CheckCheckIcon,
  CircleDotIcon,
  EllipsisIcon,
  TagIcon,
  UserPlusIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { useMarkIssuesReadAction } from "@/api/reads.ts";
import { BulkAssigneeMenu } from "@/components/issue/bulk-assignee-menu.tsx";
import {
  BULK_INLINE,
  BULK_OVERFLOW,
  BULK_TEXT,
  BulkButton,
} from "@/components/issue/bulk-button.tsx";
import { BulkLabelMenu } from "@/components/issue/bulk-label-menu.tsx";
import {
  BulkStatusItems,
  BulkStatusMenu,
  useBulkIssueStatus,
} from "@/components/issue/bulk-status-menu.tsx";
import { useSelectedRows } from "@/lib/use-selected-rows.ts";

/**
 * What a selection can do (T-707, T-775), for the list and the board alike.
 * The row holding it carries `@container/bulk`; see bulk-button.tsx for how
 * the group narrows with it.
 *
 * Set status spends the selection, because the cards leave the place they
 * were picked from. The other three keep it, so a selection can be labelled,
 * assigned and read in one go.
 */
export function BulkActions({
  slug,
  statuses,
  issueNumbers,
  onMoved,
}: {
  slug: string;
  statuses: readonly Status[];
  issueNumbers: readonly number[];
  onMoved?: () => void;
}) {
  const rows = useSelectedRows(slug, issueNumbers);
  const anyUnread = rows.some((row) => row.unread);
  const { mutate: markRead } = useMarkIssuesReadAction();
  const readAll = () => markRead({ slug, numbers: [...issueNumbers] });

  return (
    <>
      <div className={`flex items-center gap-2 ${BULK_INLINE}`}>
        <BulkStatusMenu
          slug={slug}
          statuses={statuses}
          issueNumbers={issueNumbers}
          onMoved={onMoved}
        />
        <BulkLabelMenu slug={slug} issueNumbers={issueNumbers} />
        <BulkAssigneeMenu slug={slug} issueNumbers={issueNumbers} />
        <BulkButton
          label="Mark read"
          icon={<CheckCheckIcon />}
          disabled={!anyUnread}
          onClick={readAll}
        >
          <span className={BULK_TEXT}>Mark read</span>
        </BulkButton>
      </div>
      <BulkOverflowMenu
        slug={slug}
        statuses={statuses}
        issueNumbers={issueNumbers}
        onMoved={onMoved}
        anyUnread={anyUnread}
        onReadAll={readAll}
      />
    </>
  );
}

/**
 * The narrowest row's version: one menu. Labels and Assignees are pickers,
 * not menus, so choosing one closes the menu and opens its picker against
 * the same button.
 */
function BulkOverflowMenu({
  slug,
  statuses,
  issueNumbers,
  onMoved,
  anyUnread,
  onReadAll,
}: {
  slug: string;
  statuses: readonly Status[];
  issueNumbers: readonly number[];
  onMoved?: () => void;
  anyUnread: boolean;
  onReadAll: () => void;
}) {
  const [picker, setPicker] = useState<"labels" | "assignees" | null>(null);
  // Opened only once the menu has finished closing: opened from the item
  // itself, the picker takes focus while the menu still holds it, the menu's
  // teardown drops focus to the body, and the picker reads that as a focus
  // leaving it and closes again.
  const pending = useRef<"labels" | "assignees" | null>(null);
  const move = useBulkIssueStatus(slug, issueNumbers, onMoved);
  // Never clicked: it only gives the pickers a place to hang from. Over the
  // menu button, so they open where the menu did.
  const anchor = (
    <span aria-hidden className="pointer-events-none absolute inset-0" />
  );
  const onOpenChange = (which: "labels" | "assignees") => (open: boolean) =>
    setPicker(open ? which : null);

  return (
    <div className={`relative ${BULK_OVERFLOW}`}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Selection actions"
            title="Selection actions"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          // As wide as its longest item; the trigger it would otherwise
          // match is a 28px icon.
          className="w-auto"
          onCloseAutoFocus={(e) => {
            if (pending.current === null) return;
            // Focus belongs to the picker, not back on the menu's button.
            e.preventDefault();
            setPicker(pending.current);
            pending.current = null;
          }}
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <CircleDotIcon />
              Set status
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-auto min-w-64">
              <BulkStatusItems statuses={statuses} onPick={move} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onSelect={() => {
              pending.current = "labels";
            }}
          >
            <TagIcon />
            Labels…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              pending.current = "assignees";
            }}
          >
            <UserPlusIcon />
            Assignees…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!anyUnread} onSelect={onReadAll}>
            <CheckCheckIcon />
            Mark read
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BulkLabelMenu
        slug={slug}
        issueNumbers={issueNumbers}
        trigger={anchor}
        open={picker === "labels"}
        onOpenChange={onOpenChange("labels")}
      />
      <BulkAssigneeMenu
        slug={slug}
        issueNumbers={issueNumbers}
        trigger={anchor}
        open={picker === "assignees"}
        onOpenChange={onOpenChange("assignees")}
      />
    </div>
  );
}
