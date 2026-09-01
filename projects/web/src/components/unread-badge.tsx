import { cn } from "@/lib/utils";

/**
 * The unread count, wherever it is shown (T-202). Shared rather than copied
 * because the navbar badge and the project switcher's per-row badges count
 * the same thing — inbox rows — and a reader who sees them disagree in
 * shape or in the >99 cutoff would read that as two different metrics.
 * Placement is the caller's: only the pill itself lives here.
 */
export function UnreadBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] leading-none font-semibold text-white tabular-nums dark:bg-blue-500",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
