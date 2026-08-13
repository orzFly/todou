import type { Status } from "@todou/shared";
import { cn } from "@/lib/utils";

/**
 * Vertical metrics (text-xs, py-0.5, border) must equal LabelChip's — see the
 * note there (T-98).
 */
export function StatusPill({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
        className,
      )}
    >
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: status.color }}
        aria-hidden
      />
      {status.name}
    </span>
  );
}
