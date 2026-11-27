import { cn } from "@orz/ui";
import { Badge } from "@orz/ui/components/badge";

/**
 * The unread count, wherever it is shown (T-202). Shared rather than copied
 * because the navbar badge and the project switcher's per-row badges count
 * the same thing — inbox rows — and a reader who sees them disagree in
 * shape or in the >99 cutoff would read that as two different metrics.
 * Placement is the caller's: only the count itself lives here.
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
    <Badge
      aria-hidden
      className={cn("h-4 min-w-4 px-1 tabular-nums", className)}
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
