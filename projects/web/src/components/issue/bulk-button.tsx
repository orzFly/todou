import { cn } from "@orz/ui";
import { Button } from "@orz/ui/components/button";
import type { ComponentProps, ReactNode } from "react";

// The selection's actions read their room off the toolbar row they sit in,
// which carries `@container/bulk` (T-775). Below the first width the labels
// drop and the buttons go square; below the second the whole group folds
// into one overflow menu. While anything is selected the row holds the
// selection alone (T-778), and the group does not wrap, so each width is
// the group's own: measured on the list's row, the wider of the two because
// of its select-all box (2026-11-18, a three-digit count), labelled 578px
// and icons 288px, each width set just above. The board's row is narrower
// by that box and holds one line at every width either version is shown at.
export const BULK_TEXT = "@max-[36.25rem]/bulk:sr-only";
export const BULK_CHEVRON = "@max-[36.25rem]/bulk:hidden";
export const BULK_INLINE = "@max-[18.25rem]/bulk:hidden";
export const BULK_OVERFLOW = "hidden @max-[18.25rem]/bulk:inline-flex";

/**
 * One of the selection's action buttons: its label is the children, kept
 * for screen readers and the tooltip once the row is too narrow to show it.
 */
export function BulkButton({
  label,
  icon,
  className,
  children,
  ...props
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
} & ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      size="sm"
      title={label}
      className={cn(
        "@max-[36.25rem]/bulk:w-7 @max-[36.25rem]/bulk:px-0",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </Button>
  );
}
