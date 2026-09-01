/**
 * Rename detection between two spec version snapshots.
 *
 * Renames are never stored: like git, a version is a path→body snapshot and
 * a rename is inferred at read time, so the same pair of versions can be
 * paired differently under a different threshold. This is a hand-written
 * alignment with git's `diffcore-rename` on its text path — exact matches
 * first, then a byte-weighted line-multiset similarity with git's default
 * `-M50%` — deviating in one place: git splits an over-long line into 64-byte
 * spans, which markdown under the 1MB push cap never needs.
 *
 * Zero dependencies and no host globals: web, CLI and server all consume it.
 */

/** One `from → to` pairing; `identical` marks a rename that changed nothing. */
export type SpecRename = {
  from: string;
  to: string;
  identical: boolean;
};

/** git's default -M50%: half the larger side has to survive the move. */
const RENAME_THRESHOLD = 0.5;

/** UTF-8 length without allocating an encoder per line. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The comparison unit, terminator included — git hashes its spans the same
 * way, so a line that only moved still counts as carried over.
 */
function linesOf(body: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\n") {
      lines.push(body.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < body.length) lines.push(body.slice(start));
  return lines;
}

type Profile = { counts: Map<string, number>; bytes: number };

function profileOf(body: string): Profile {
  const counts = new Map<string, number>();
  let bytes = 0;
  for (const line of linesOf(body)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
    bytes += utf8Length(line);
  }
  return { counts, bytes };
}

/** Shared bytes over the larger side — git's `estimate_similarity`. */
function similarity(a: Profile, b: Profile): number {
  const max = Math.max(a.bytes, b.bytes);
  if (max === 0) return 0;
  let common = 0;
  for (const [line, count] of a.counts) {
    const other = b.counts.get(line);
    if (other === undefined) continue;
    common += Math.min(count, other) * utf8Length(line);
  }
  return common / max;
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pairs files the later version dropped with files it gained, newest path
 * first in the result. Candidates are only ever removed × added — git does
 * not detect copies by default either — and empty files never pair, having
 * no content to carry an identity.
 */
export function detectRenames(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): SpecRename[] {
  const sources = [...before.keys()]
    .filter((path) => !after.has(path) && before.get(path) !== "")
    .sort(byPath);
  const targets = [...after.keys()]
    .filter((path) => !before.has(path) && after.get(path) !== "")
    .sort(byPath);
  if (sources.length === 0 || targets.length === 0) return [];

  const takenSource = new Set<string>();
  const takenTarget = new Set<string>();
  const renames: SpecRename[] = [];
  const pair = (from: string, to: string) => {
    takenSource.add(from);
    takenTarget.add(to);
    renames.push({ from, to, identical: before.get(from) === after.get(to) });
  };

  for (const from of sources) {
    const body = before.get(from);
    const to = targets.find(
      (path) => !takenTarget.has(path) && after.get(path) === body,
    );
    if (to !== undefined) pair(from, to);
  }

  const profiles = new Map<string, Profile>();
  const profile = (path: string, body: string): Profile => {
    let cached = profiles.get(path);
    if (cached === undefined) {
      cached = profileOf(body);
      profiles.set(path, cached);
    }
    return cached;
  };
  const scored: Array<{ from: string; to: string; score: number }> = [];
  for (const from of sources) {
    if (takenSource.has(from)) continue;
    for (const to of targets) {
      if (takenTarget.has(to)) continue;
      const score = similarity(
        profile(from, before.get(from) ?? ""),
        profile(to, after.get(to) ?? ""),
      );
      if (score >= RENAME_THRESHOLD) scored.push({ from, to, score });
    }
  }
  // Best-first, so a source that resembles two targets lands on the closer
  // one; ties fall back to path order rather than to iteration order.
  scored.sort(
    (a, b) => b.score - a.score || byPath(a.from, b.from) || byPath(a.to, b.to),
  );
  for (const candidate of scored) {
    if (takenSource.has(candidate.from) || takenTarget.has(candidate.to)) {
      continue;
    }
    pair(candidate.from, candidate.to);
  }

  return renames.sort((a, b) => byPath(a.to, b.to));
}
