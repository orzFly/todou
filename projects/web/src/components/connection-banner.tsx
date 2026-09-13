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
 *
 * Rendered inside the shell `<header>`, not between header and page: the
 * header is sticky, so a static bar after it would scroll away behind its
 * backdrop-blur, and a sticky bar of its own would land on the same strip
 * the page's own toolbars pin to — on every draft surface with a toolbar
 * (issue list, issue detail, spec view) scrolling pins the toolbar over the
 * banner and the warning stops existing exactly when a long form is being
 * filled. Inside the header it is simply part of the sticky chrome: the
 * header (and the banner with it) is what `useHeaderHeight()` measures, so
 * every pinned toolbar shifts down while the banner is up and needs no
 * per-page coordination.
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
      className="border-t border-b bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-900/60"
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
