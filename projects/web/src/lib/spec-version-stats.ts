import { detectRenames, type SpecPushedPayload } from "@todou/shared";

// Per-file git-stats for a spec version card (T-59). Line counts are
// derived on demand from the immutable version snapshots — the
// spec_pushed payload stays stats-free, so cards grow under events that
// predate this feature too.

export type SpecFileStat = {
  /** The path in the later version; for a rename, the one it moved to. */
  path: string;
  change: "added" | "modified" | "removed" | "renamed";
  /** The path it moved from — `renamed` only. */
  from?: string;
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

/**
 * The one place a rename is inferred for the web app: every surface that
 * shows per-file diff stats — the timeline version card, the issue page's
 * spec entry, the spec page's file rail — reads them from here, so a
 * deterministic pairing here is the same pairing everywhere (T-203).
 */
export function computeVersionStats(
  payload: Pick<SpecPushedPayload, "added" | "changed" | "removed">,
  before: Map<string, string>,
  after: Map<string, string>,
  diffLines: DiffLines,
): SpecFileStat[] {
  const countDiff = (from: string, to: string) => {
    let plus = 0;
    let minus = 0;
    for (const part of diffLines(from, to)) {
      if (part.added) plus += part.count ?? 0;
      else if (part.removed) minus += part.count ?? 0;
    }
    return { plus, minus };
  };

  // The payload decides what counts as added and removed; the snapshots only
  // supply the bodies. Pairing outside those lists would collapse a removed
  // row into a renamed row that never gets rendered.
  const addedPaths = new Set(payload.added);
  const removedPaths = new Set(payload.removed);
  const renames = detectRenames(before, after).filter(
    (rename) => removedPaths.has(rename.from) && addedPaths.has(rename.to),
  );
  const renamedFrom = new Map(renames.map((r) => [r.to, r.from]));
  const renamedAway = new Set(renames.map((r) => r.from));

  const stats: SpecFileStat[] = [];
  for (const path of payload.added) {
    const from = renamedFrom.get(path);
    if (from !== undefined) {
      stats.push({
        path,
        change: "renamed",
        from,
        ...countDiff(before.get(from) ?? "", after.get(path) ?? ""),
      });
      continue;
    }
    stats.push({
      path,
      change: "added",
      plus: lineCount(after.get(path) ?? ""),
      minus: 0,
    });
  }
  for (const path of payload.changed) {
    stats.push({
      path,
      change: "modified",
      ...countDiff(before.get(path) ?? "", after.get(path) ?? ""),
    });
  }
  for (const path of payload.removed) {
    if (renamedAway.has(path)) continue;
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
