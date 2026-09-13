import { Button } from "@/components/ui/button";
import { useHeaderHeight } from "@/lib/use-header-height.ts";

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
  // The header's height is a runtime value (it grows a nav row below sm), so
  // the offset cannot be a CSS constant — same reason the issue list's
  // toolbar and the floating title bar measure it.
  const headerHeight = useHeaderHeight();
  return (
    <div
      role="status"
      style={{ top: headerHeight }}
      /* Sticky, so the warning survives the scroll that filling a long form
         produces; a static bar slides away behind the header's backdrop-blur
         and stops existing exactly when it matters. z-30 puts this layer on
         the page-toolbar shelf (floating title bar, list toolbar, spec
         toolbar): when one of those is also pinned, DOM order puts this bar
         underneath — the page's own controls keep working, and the failure
         is still visible the moment they scroll away. Above that shelf sits
         only the header (z-40) and the modals (z-50), which must win. */
      className="sticky z-30 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
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
