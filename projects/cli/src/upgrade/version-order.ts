/**
 * The release form `v0.6.5` and the everyday form `v0.6.5-12-g2cc59bb`
 * (docs/release.md) ordered as git describe means them: the everyday form is
 * 12 commits past the tag, so it sorts after it.
 *
 * A `-dirty` suffix, a bare sha and `unknown` name no position on that line,
 * and the nix form `0.6.5-g2cc59bb` names a commit without saying how far past
 * the tag it is. All of those are incomparable — the caller has to decide
 * without an ordering rather than be handed a guess.
 */
const DESCRIBE = /^v(\d+)\.(\d+)\.(\d+)(?:-(\d+)-g[0-9a-f]+)?$/;

type Position = [number, number, number, number];

function position(version: string): Position | null {
  const m = DESCRIBE.exec(version);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
}

/** Negative, zero or positive like a sort comparator; null when either side has no position. */
export function compareVersions(a: string, b: string): number | null {
  const pa = position(a);
  const pb = position(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether installing `candidate` over `current` moves forward. An equal
 * string is never newer; an incomparable `current` (a dirty or tagless build)
 * accepts any comparable candidate, since the user asked to upgrade and there
 * is nothing to protect from a downgrade.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (candidate === current) return false;
  const order = compareVersions(candidate, current);
  if (order !== null) return order > 0;
  return position(candidate) !== null && position(current) === null;
}
