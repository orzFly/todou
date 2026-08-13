import type { Label } from "@todou/shared";
import { cn } from "@/lib/utils";

/**
 * Split a structured label name at the first colon. A leading colon is not a
 * prefix (":oops" stays whole) — hence > 0, not >= 0.
 */
export function splitLabelName(name: string): {
  prefix: string | null;
  value: string;
} {
  const i = name.indexOf(":");
  if (i > 0) return { prefix: name.slice(0, i + 1), value: name.slice(i + 1) };
  return { prefix: null, value: name };
}

/**
 * Quiet chip (T-82): the label color lives only in the dot, the text stays in
 * foreground/muted — no `${color}22`-style translucent tints, which kept the
 * light/dark themes from needing per-color branches.
 *
 * Vertical metrics (text-xs, py-0.5, border) must equal StatusPill's: the two
 * share the list's meta line and the board card, and any difference shows up
 * as misaligned boxes and baselines (T-98).
 */
export function LabelChip({
  label,
  className,
}: {
  label: Label;
  className?: string;
}) {
  const { prefix, value } = splitLabelName(label.name);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-full border px-[7px] py-0.5 text-xs whitespace-nowrap",
        className,
      )}
      title={label.name}
    >
      <span
        className="size-[7px] shrink-0 rounded-full"
        style={{ backgroundColor: label.color }}
        aria-hidden
      />
      <span>
        {prefix && <span className="text-muted-foreground">{prefix}</span>}
        {value}
      </span>
    </span>
  );
}
