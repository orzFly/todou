import type { ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * `LoadFailure` occupies a surface that has nothing to display;
 * `RefreshFailure` sits above content retained after a transient refresh
 * failure. Both expose the raw error on the message and a retry for only the
 * failed read. A failure here does not recover by itself — unlike
 * ConnectionBanner, which is server-gone-but-cache-serves and heals — so the
 * exit has to be a control, not a promise.
 *
 * `size` scales the whole row — message and button together — because the two
 * `text-xs` surfaces it exists for sit in 16px contexts where an inherited
 * size would strand the message at body scale next to a proportioned button;
 * `sm` stays inheriting for body-scale surfaces. `className` merges last for
 * margins and one-off adjustments.
 */
function FailureRow({
  message,
  detail,
  onRetry,
  retrying,
  retryRef,
  size,
  className,
  textClassName,
}: {
  message: ReactNode;
  detail: string | undefined;
  onRetry: () => void;
  retrying: boolean;
  retryRef?: Ref<HTMLButtonElement>;
  size: "sm" | "xs";
  className?: string;
  textClassName: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        textClassName,
        "flex flex-wrap items-baseline gap-x-2 gap-y-1",
        size === "xs" ? "text-xs" : null,
        className,
      )}
    >
      <span title={detail}>{message}</span>
      <Button
        ref={retryRef}
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
export function LoadFailure({
  message,
  detail,
  onRetry,
  retrying,
  retryRef,
  size = "sm",
  className,
}: {
  message: ReactNode;
  detail: string | undefined;
  onRetry: () => void;
  retrying: boolean;
  /**
   * Retry is the only control a surface with nothing to display still offers,
   * which makes it the place focus has to go when an overlay opened from that
   * surface closes and its own opener is gone (T-430).
   */
  retryRef?: Ref<HTMLButtonElement>;
  size?: "sm" | "xs";
  className?: string;
}) {
  return (
    <FailureRow
      message={message}
      detail={detail}
      onRetry={onRetry}
      retrying={retrying}
      retryRef={retryRef}
      size={size}
      className={className}
      textClassName="text-destructive"
    />
  );
}

export function RefreshFailure({
  what,
  detail,
  onRetry,
  retrying,
  size = "sm",
  className,
}: {
  what: string;
  detail: string | undefined;
  onRetry: () => void;
  retrying: boolean;
  size?: "sm" | "xs";
  className?: string;
}) {
  return (
    <FailureRow
      message={`Couldn't refresh ${what} (${detail}) — showing saved data.`}
      detail={detail}
      onRetry={onRetry}
      retrying={retrying}
      size={size}
      className={className}
      textClassName="text-amber-800 dark:text-amber-200"
    />
  );
}
