import type { SpecPushedPayload } from "@todou/shared";

// Per-file git-stats for a spec version card (T-59). Line counts are
// derived on demand from the immutable version snapshots — the
// spec_pushed payload stays stats-free, so cards grow under events that
// predate this feature too.

export type SpecFileStat = {
  path: string;
  change: "added" | "modified" | "removed";
  plus: number;
  minus: number;
};

/** jsdiff's diffLines, injected so the library loads lazily. */
type DiffLines = (
  a: string,
  b: string,
) => Array<{ count?: number; added?: boolean; removed?: boolean }>;

function lineCount(body: string): number {
  if (body === "") return 0;
  return body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
}

export function computeVersionStats(
  payload: Pick<SpecPushedPayload, "added" | "changed" | "removed">,
  before: Map<string, string>,
  after: Map<string, string>,
  diffLines: DiffLines,
): SpecFileStat[] {
  const stats: SpecFileStat[] = [];
  for (const path of payload.added) {
    stats.push({
      path,
      change: "added",
      plus: lineCount(after.get(path) ?? ""),
      minus: 0,
    });
  }
  for (const path of payload.changed) {
    let plus = 0;
    let minus = 0;
    for (const part of diffLines(
      before.get(path) ?? "",
      after.get(path) ?? "",
    )) {
      if (part.added) plus += part.count ?? 0;
      else if (part.removed) minus += part.count ?? 0;
    }
    stats.push({ path, change: "modified", plus, minus });
  }
  for (const path of payload.removed) {
    stats.push({
      path,
      change: "removed",
      plus: 0,
      minus: lineCount(before.get(path) ?? ""),
    });
  }
  return stats;
}

/**
 * GitHub-diffstat cell allocation: five squares split between green and
 * red proportionally, but any non-zero side keeps at least one square.
 */
export function diffstatCells(
  plus: number,
  minus: number,
): Array<"plus" | "minus" | "none"> {
  const total = plus + minus;
  if (total === 0) return Array(5).fill("none");
  let green = Math.round((plus / total) * 5);
  if (plus > 0 && green === 0) green = 1;
  if (minus > 0 && green === 5) green = 4;
  return Array.from({ length: 5 }, (_, i) =>
    i < green ? "plus" : minus > 0 ? "minus" : "none",
  );
}
