import { useQuery } from "@tanstack/react-query";
import { UserPlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useBulkIssueMutation } from "@/api/issues.ts";
import { membersQuery } from "@/api/queries.ts";
import { AssigneePicker } from "@/components/issue/assignee-picker.tsx";
import { BULK_TEXT, BulkButton } from "@/components/issue/bulk-button.tsx";
import { coverage } from "@/components/issue/bulk-label-menu.tsx";
import { useSelectedRows } from "@/lib/use-selected-rows.ts";

/** Assignees for a selection (T-775), on BulkLabelMenu's rules. */
export function BulkAssigneeMenu({
  slug,
  issueNumbers,
  trigger,
  open,
  onOpenChange,
}: {
  slug: string;
  issueNumbers: readonly number[];
  /** Absent: the toolbar's own button. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const members = useQuery(membersQuery(slug)).data ?? [];
  const rows = useSelectedRows(slug, issueNumbers);
  const { all, some } = coverage(rows, (row) => row.assignees);
  const { mutate } = useBulkIssueMutation();

  const toggle = (userId: number) => {
    const user =
      all.find((u) => u.id === userId) ??
      members.find((m) => m.user.id === userId)?.user;
    if (!user) return;
    mutate({
      slug,
      issueNumbers: [...issueNumbers],
      change: {
        kind: "assignee",
        user,
        add: !all.some((u) => u.id === userId),
      },
    });
  };

  return (
    <AssigneePicker
      members={members}
      selectedIds={all.map((u) => u.id)}
      partialIds={some}
      onToggle={toggle}
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        trigger ?? (
          <BulkButton label="Assignees" icon={<UserPlusIcon />}>
            <span className={BULK_TEXT}>Assignees</span>
          </BulkButton>
        )
      }
    />
  );
}
