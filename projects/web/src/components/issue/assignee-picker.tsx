import type { Member } from "@todou/shared";
import type { ReactNode } from "react";
import { UserPicker } from "@/components/shared/user-picker.tsx";

/**
 * The Edit assignees picker, shared by the card page, the new-card page and
 * the board so the three cannot drift apart. `selectedIds` rather than the
 * assignees themselves: one caller holds `issue.assignees`, another only ids.
 */
export function AssigneePicker({
  members,
  selectedIds,
  onToggle,
  trigger,
  partialIds,
  open,
  onOpenChange,
  defaultOpen = false,
}: {
  members: Member[];
  selectedIds: number[];
  onToggle: (userId: number) => void;
  trigger: ReactNode;
  partialIds?: number[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Test-only, as on LabelPicker. */
  defaultOpen?: boolean;
}) {
  return (
    <UserPicker
      users={members.map((member) => member.user)}
      selectedIds={selectedIds}
      partialIds={partialIds}
      open={open}
      onOpenChange={onOpenChange}
      onPick={(user) => {
        if (user !== null) onToggle(user.id);
      }}
      trigger={trigger}
      multiple
      defaultOpen={defaultOpen}
    />
  );
}
