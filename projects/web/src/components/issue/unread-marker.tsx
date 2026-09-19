import { enumLookup, type MuteReason } from "@todou/shared";

const muteSuffixes = {
  project: " — the whole project is muted",
  forever: " — this card is muted",
  until_activity: " — this card is muted",
} satisfies Record<MuteReason, string>;

/**
 * Three-state unread marker (T-77): a count badge when foreign comments are
 * waiting, a hollow ring when only events happened, nothing when read.
 * Positioning (list slot / board corner) stays at the call sites.
 *
 * A muted card (T-372) keeps its marker — the unread is real, and the
 * settings page's counts depend on it staying honest — but drops the blue
 * for muted-foreground: blue is reserved for what is asking for attention
 * *now*, and this card has been told to wait. `muted-foreground` follows
 * the theme, so no dark: variants pair with it.
 */
export function UnreadMarker({
  unread,
  unreadComments,
  muted = null,
}: {
  unread: boolean;
  unreadComments: number;
  muted?: MuteReason | null;
}) {
  const suffix =
    muted === null
      ? ""
      : enumLookup(
          muteSuffixes,
          muted,
          (value) => ` — mute reason: ${value}`,
          "mute reason",
        );
  if (unreadComments > 0) {
    // Cap is display-only; the tooltip keeps the exact count. One shade
    // darker than the ring so the white digits stay readable (T-77).
    const label = `${unreadComments} new comment${unreadComments === 1 ? "" : "s"} since you last viewed${suffix}`;
    return (
      <span
        className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10.5px] leading-none font-semibold tabular-nums ${
          muted === null
            ? "bg-blue-600 text-white dark:bg-blue-500"
            : "bg-muted-foreground/70 text-background"
        }`}
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
        className={`size-2 rounded-full border-[1.5px] ${
          muted === null
            ? "border-blue-500 dark:border-blue-400"
            : "border-muted-foreground/60"
        }`}
        title={`new activity since you last viewed${suffix}`}
      />
    );
  }
  return null;
}
