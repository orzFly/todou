import type { Label } from "@todou/shared";
import { groupLabelsByPrefix, splitLabelName } from "@/lib/labels.ts";

/**
 * The only two ways a label reaches the screen (T-715): one label, or a list
 * of them. Both draw the same atom — a `prefix:` in muted text beside a chip
 * holding the value, or the whole name in the chip when there is no prefix —
 * and a list only folds a repeated prefix. Neither takes styling props: a
 * second look for a label was how the sidebar and the timeline came to
 * disagree, and `label-status-rendering.test.ts` fails on any drawing that
 * goes around these two.
 */
export function LabelChip({ label }: { label: Label }) {
  return (
    <LabelGroup prefix={splitLabelName(label.name).prefix} labels={[label]} />
  );
}

/**
 * Each group is a single inline-flex unit so a wrapping container breaks
 * between groups, never inside one.
 */
export function LabelChips({ labels }: { labels: Label[] }) {
  const { groups, plain } = groupLabelsByPrefix(labels);
  return (
    <>
      {groups.map((group) => (
        <LabelGroup
          key={group.prefix}
          prefix={group.prefix}
          labels={group.labels}
        />
      ))}
      {plain.map((label) => (
        <LabelGroup key={label.id} prefix={null} labels={[label]} />
      ))}
    </>
  );
}

/*
 * `align-middle` only acts where a label sits in running text (a timeline
 * sentence); everywhere else the group is a flex item and ignores it.
 */
function LabelGroup({
  prefix,
  labels,
}: {
  prefix: string | null;
  labels: Label[];
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 align-middle">
      {prefix && (
        <span className="text-xs text-muted-foreground">{prefix}</span>
      )}
      {labels.map((label) => (
        <Chip
          key={label.id}
          label={label}
          text={prefix ? splitLabelName(label.name).value : label.name}
        />
      ))}
    </span>
  );
}

/**
 * Tinted chip (T-90): a `${color}22` background with same-color text and no
 * dot, so it reads differently from a status pill at a glance.
 *
 * Vertical metrics (text-xs, py-0.5, border) must equal StatusPill's: the two
 * share the list's meta line and the board card, and any difference shows up
 * as misaligned boxes and baselines (T-98).
 */
function Chip({ label, text }: { label: Label; text: string }) {
  return (
    <span
      className="inline-flex min-w-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{
        backgroundColor: `${label.color}22`,
        color: label.color,
        borderColor: `${label.color}55`,
      }}
      title={label.name}
    >
      {/* `text-overflow` has no effect on the inline-flex box itself, hence the
          inner span; `clip` rather than `hidden`, because `hidden` would move
          the chip's baseline to its bottom edge where it sits in a sentence. */}
      <span className="min-w-0 overflow-clip text-ellipsis">{text}</span>
    </span>
  );
}
