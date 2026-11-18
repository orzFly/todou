import { useQuery } from "@tanstack/react-query";
import type { IssueListItem, Label } from "@todou/shared";
import { TagIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useBulkIssueMutation } from "@/api/issues.ts";
import { labelsQuery, useCanIfLoaded } from "@/api/queries.ts";
import { BULK_TEXT, BulkButton } from "@/components/issue/bulk-button.tsx";
import {
  LabelPicker,
  useCreateLabel,
} from "@/components/issue/label-picker.tsx";
import { useSelectedRows } from "@/lib/use-selected-rows.ts";

/**
 * How many of `rows` carry each id: every one of them → `all`, some → `some`.
 * The two lists a three-state picker shows (T-775).
 */
export function coverage<T extends { id: number }>(
  rows: readonly IssueListItem[],
  setOf: (row: IssueListItem) => readonly T[],
): { all: T[]; some: number[] } {
  const counts = new Map<number, { item: T; count: number }>();
  for (const row of rows) {
    for (const item of setOf(row)) {
      const entry = counts.get(item.id);
      if (entry) entry.count++;
      else counts.set(item.id, { item, count: 1 });
    }
  }
  const all: T[] = [];
  const some: number[] = [];
  for (const { item, count } of counts.values()) {
    if (rows.length > 0 && count === rows.length) all.push(item);
    else some.push(item.id);
  }
  return { all, some };
}

/**
 * Labels for a selection (T-775). A label every selected card carries comes
 * off all of them; any other goes onto all of them. Stays open across
 * toggles, as the single-card picker does.
 */
export function BulkLabelMenu({
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
  const allLabels = useQuery(labelsQuery(slug)).data ?? [];
  const canCreate = useCanIfLoaded(slug, "label.create");
  const createLabel = useCreateLabel(slug);
  const rows = useSelectedRows(slug, issueNumbers);
  const { all, some } = coverage(rows, (row) => row.labels);
  const { mutate } = useBulkIssueMutation();

  const toggle = (label: Label) =>
    mutate({
      slug,
      issueNumbers: [...issueNumbers],
      change: {
        kind: "label",
        label,
        add: !all.some((l) => l.id === label.id),
      },
    });

  return (
    <LabelPicker
      allLabels={allLabels}
      selected={all}
      partialIds={some}
      onToggle={toggle}
      onCreate={canCreate ? createLabel : undefined}
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        trigger ?? (
          <BulkButton label="Labels" icon={<TagIcon />}>
            <span className={BULK_TEXT}>Labels</span>
          </BulkButton>
        )
      }
    />
  );
}
