/**
 * Three-state unread marker (T-77): a count badge when foreign comments are
 * waiting, a hollow ring when only events happened, nothing when read.
 * Positioning (list slot / board corner) stays at the call sites.
 */
export function UnreadMarker({
  unread,
  unreadComments,
}: {
  unread: boolean;
  unreadComments: number;
}) {
  if (unreadComments > 0) {
    // Cap is display-only; the tooltip keeps the exact count. One shade
    // darker than the ring so the white digits stay readable (T-77).
    const label = `${unreadComments} new comment${unreadComments === 1 ? "" : "s"} since you last viewed`;
    return (
      <span
        className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10.5px] leading-none font-semibold text-white tabular-nums dark:bg-blue-500"
        title={label}
        // Bare spans can't carry aria-label; as a named image the exact
        // count survives the visual 99+ cap for screen readers too.
        role="img"
        aria-label={label}
      >
        {unreadComments > 99 ? "99+" : unreadComments}
      </span>
    );
  }
  if (unread) {
    return (
      <span
        className="size-2 rounded-full border-[1.5px] border-blue-500 dark:border-blue-400"
        title="new activity since you last viewed"
      />
    );
  }
  return null;
}
