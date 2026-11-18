import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The selection's actions read their room off the toolbar row they sit in,
// which carries `@container/bulk` (T-775). Below the first width the labels
// drop and the buttons go square; below the second the whole group folds
// into one overflow menu. Measured on the list's row, the tighter of the two
// (2026-11-18, nobody watching, a one-digit count): with labels the row holds
// one line down to 888px, with icons down to 600px, so each width sits just
// above where the wider version would wrap. The board's row holds one line
// at every width either version is shown at.
export const BULK_TEXT = "@max-[56rem]/bulk:sr-only";
export const BULK_CHEVRON = "@max-[56rem]/bulk:hidden";
export const BULK_INLINE = "@max-[38rem]/bulk:hidden";
export const BULK_OVERFLOW = "hidden @max-[38rem]/bulk:inline-flex";

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
      className={cn("@max-[56rem]/bulk:w-7 @max-[56rem]/bulk:px-0", className)}
      {...props}
    >
      {icon}
      {children}
    </Button>
  );
}
