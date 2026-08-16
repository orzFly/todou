import type { Label } from "@todou/shared";

// Canonicalization is the server's rule now (T-136) — re-exported rather
// than reimplemented so the picker's preview cannot drift from what a
// create actually stores.
export { canonicalizeLabelName } from "@todou/shared";

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

/** Preset swatches offered in the color popover (statuses and labels). */
export const PRESET_COLORS = [
  "#6b7280",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#0ea5e9",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

/**
 * Near-duplicate comparison key. Stripping *all* whitespace (not just
 * collapsing it) is what makes "area: web" collide with "area:web".
 */
export function labelNearKey(input: string): string {
  return input.toLowerCase().replace(/\s+/g, "");
}

/**
 * Deterministic default color for an on-the-fly label: the same name always
 * hashes to the same preset, so a retried create doesn't flicker colors.
 */
export function labelColorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return PRESET_COLORS[h % PRESET_COLORS.length] as string;
}

export type LabelGroups<T extends Label> = {
  groups: Array<{ prefix: string; labels: T[] }>;
  plain: T[];
};

/**
 * Group labels by their name prefix for the "`area:` text + value badges"
 * rendering. Input order is preserved (the API sorts by name), so groups
 * come out in alphabetical first-appearance order.
 */
export function groupLabelsByPrefix<T extends Label>(
  labels: T[],
): LabelGroups<T> {
  const groups = new Map<string, T[]>();
  const plain: T[] = [];
  for (const label of labels) {
    const { prefix } = splitLabelName(label.name);
    if (prefix === null) {
      plain.push(label);
      continue;
    }
    const bucket = groups.get(prefix);
    if (bucket) bucket.push(label);
    else groups.set(prefix, [label]);
  }
  return {
    groups: [...groups].map(([prefix, ls]) => ({ prefix, labels: ls })),
    plain,
  };
}
