import { Button } from "@/components/ui/button";

/**
 * A failed background refetch of account data (`/api/me`): the page keeps
 * running on cached data and heals on its own once the server answers again
 * (a 15s retry interval, or a manual retry). Like `VersionFooter`'s version
 * mismatch — the same class of self-recovering, transient state — this is
 * colour and a sentence, not a border or an icon, and it never interrupts
 * with a toast.
 *
 * The button exists because waiting out the interval is the worst part of an
 * outage that has already ended: one click refetches now.
 */
export function ConnectionBanner({
  message,
  onRetry,
}: {
  /** What failed, in the client's own words (`TodouError.message`). */
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="status"
      className="bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-1.5 text-xs">
        <span>
          Couldn't reach the todou server ({message}) — showing saved data until
          it answers again.
        </span>
        <Button variant="ghost" size="xs" onClick={onRetry}>
          Retry now
        </Button>
      </div>
    </div>
  );
}
