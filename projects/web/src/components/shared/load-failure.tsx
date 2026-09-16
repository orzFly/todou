import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one way a "this section did not load" surface looks: the screen's own
 * message, the raw error on a `title`, and a retry that refetches only this
 * section's query. A failure here does not recover by itself — unlike
 * ConnectionBanner, which is server-gone-but-cache-serves and heals — so the
 * exit has to be a control, not a promise.
 *
 * `size` is the proportional escape hatch for `text-xs` surfaces; `className`
 * merges last so callers can adjust font size and margins on the line.
 */
export function LoadFailure({
  message,
  detail,
  onRetry,
  retrying,
  size = "sm",
  className,
}: {
  message: ReactNode;
  detail: string | undefined;
  onRetry: () => void;
  retrying: boolean;
  size?: "sm" | "xs";
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "text-destructive flex flex-wrap items-baseline gap-x-2 gap-y-1",
        className,
      )}
    >
      <span title={detail}>{message}</span>
      <Button
        variant="outline"
        size={size}
        onClick={onRetry}
        disabled={retrying}
      >
        Retry
      </Button>
    </div>
  );
}
