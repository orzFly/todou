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
 * `size` scales the whole block — message line and button together — because
 * the two `text-xs` surfaces it exists for (questions card, revision
 * history) sit in 16px contexts where an inherited size would strand the
 * message at body scale next to a proportioned button; `sm` stays
 * inheriting, which is what the twelve `text-sm` ancestors already provide
 * (and what inbox's body-scale line has always been). `className` merges
 * last for margins and one-off adjustments.
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
        size === "xs" ? "text-xs" : null,
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
