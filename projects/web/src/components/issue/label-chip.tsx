import type { Label } from "@todou/shared";
import { groupLabelsByPrefix, splitLabelName } from "@/lib/labels.ts";
import { cn } from "@/lib/utils";

export { splitLabelName };

/**
 * Tinted chip (T-90, reverting T-82's dot style): a full `${color}22`
 * background with same-color text, no dot — a status pill is outlined with a
 * dot, so the two read differently at a glance, which T-82's quiet chips
 * didn't.
 *
 * Vertical metrics (text-xs, py-0.5, border) must equal StatusPill's: the two
 * share the list's meta line and the board card, and any difference shows up
 * as misaligned boxes and baselines (T-98). `bordered: false` keeps a
 * transparent border for the same reason.
 */
export function LabelChip({
  label,
  valueOnly = false,
  bordered = true,
  className,
}: {
  label: Label;
  valueOnly?: boolean;
  bordered?: boolean;
  className?: string;
}) {
  const { value } = splitLabelName(label.name);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        className,
      )}
      style={{
        backgroundColor: `${label.color}22`,
        color: label.color,
        borderColor: bordered ? `${label.color}55` : "transparent",
      }}
      title={label.name}
    >
      {valueOnly ? value : label.name}
    </span>
  );
}

/**
 * A single label inside a menu row: muted prefix outside a borderless
 * value-only badge, matching how LabelChips renders whole lists.
 */
export function LabelInline({ label }: { label: Label }) {
  const { prefix } = splitLabelName(label.name);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {prefix && (
        <span className="text-xs text-muted-foreground">{prefix}</span>
      )}
      <LabelChip label={label} valueOnly bordered={false} />
    </span>
  );
}

/**
 * Grouped label list: labels sharing a `prefix:` render as the prefix in
 * muted text followed by one value-only chip each; unprefixed labels keep the
 * full chip. Each group is a single inline-flex unit so a wrapping container
 * breaks between groups, never inside one.
 */
export function LabelChips({
  labels,
  className,
}: {
  labels: Label[];
  className?: string;
}) {
  const { groups, plain } = groupLabelsByPrefix(labels);
  return (
    <>
      {groups.map((group) => (
        <span
          key={group.prefix}
          className={cn("inline-flex items-center gap-1", className)}
        >
          <span className="text-xs text-muted-foreground">{group.prefix}</span>
          {group.labels.map((label) => (
            <LabelChip key={label.id} label={label} valueOnly />
          ))}
        </span>
      ))}
      {plain.map((label) => (
        <LabelChip key={label.id} label={label} className={className} />
      ))}
    </>
  );
}
