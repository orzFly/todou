import { useQuery } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { prefsQuery } from "@/api/prefs.ts";
import { useMarkReadAction } from "@/api/reads.ts";
import { UnreadMarker } from "@/components/issue/unread-marker.tsx";

/**
 * The unread marker as a button (T-81): hover or focus flips the badge/ring
 * to a check, clicking marks the issue read without opening it. Local
 * `marked` state hides the marker even where row data lives outside the
 * query cache (the list's Load-more pages sit in component state), while
 * the hook's cache patch covers first-page rows and board columns; an error
 * resets both layers, so the marker comes back.
 *
 * The weak-unread preference gate lives here, not in UnreadMarker: hiding
 * only the ring would leave an invisible but hoverable button behind
 * (T-97). Marker and click target vanish together.
 */
export function MarkReadButton({
  slug,
  number,
  unread,
  unreadComments,
}: {
  slug: string;
  number: number;
  unread: boolean;
  unreadComments: number;
}) {
  const [marked, setMarked] = useState(false);
  const { mutate } = useMarkReadAction(slug, number);
  // Absent or still-loading prefs behave like the default (show): the
  // marker must never flicker off while the query warms up.
  const showWeakUnread = useQuery(prefsQuery).data?.show_weak_unread ?? true;
  if ((!unread && unreadComments === 0) || marked) return null;
  if (!showWeakUnread && unreadComments === 0) return null;

  // The button's accessible name replaces the marker's own role="img"
  // label, so the count has to travel along.
  const label =
    unreadComments > 0
      ? `${unreadComments} new comment${unreadComments === 1 ? "" : "s"} — mark as read`
      : "new activity — mark as read";
  // min-w, not a fixed width: the 99+ badge runs ~27px, wider than the
  // 24px hit target, and the hover circle should still wrap it fully.
  return (
    <button
      type="button"
      className="group inline-flex h-6 min-w-6 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMarked(true);
        mutate(undefined, { onError: () => setMarked(false) });
      }}
    >
      <span className="inline-flex group-hover:hidden group-focus-visible:hidden">
        <UnreadMarker unread={unread} unreadComments={unreadComments} />
      </span>
      <CheckIcon className="hidden size-3.5 group-hover:block group-focus-visible:block" />
    </button>
  );
}
