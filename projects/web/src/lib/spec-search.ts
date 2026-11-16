/**
 * The spec page's URL model: which version is on screen, what it is compared
 * against, and how that comparison is drawn (T-192). Only a comparison is
 * ever spelled out here — reading without one, and the presentation picked
 * while doing so, stay session state (T-200).
 *
 * Kept out of the page module so the route table can validate the search
 * params without pulling @pierre/diffs into the main bundle.
 */

export type SpecView = "rendered" | "source";

export type SpecSearch = {
  file?: string;
  /** Absent only on the way in: the page pins it to the version it opened on. */
  v?: number;
  compare?: number;
  view?: SpecView;
};

export function parseSpecSearch(search: Record<string, unknown>): SpecSearch {
  const num = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return {
    file: typeof search.file === "string" ? search.file : undefined,
    v: num(search.v),
    compare: num(search.compare),
    view:
      search.view === "rendered" || search.view === "source"
        ? search.view
        : undefined,
  };
}

export type SpecMode = {
  /** null while the page is read without comparing. */
  baseline: number | null;
  /**
   * null exactly when `baseline` is: with comparing off the presentation is
   * a session stance the URL deliberately does not carry, so the page falls
   * back to its own state rather than to a value invented here (T-200).
   */
  view: SpecView | null;
};

/**
 * Resolves the two orthogonal controls from the URL.
 *
 * A pinned `compare` with no `view` is a link written before the split, and
 * every one of those opened the source diff — so that stays the default,
 * while an absent `compare` keeps meaning "previous version, rendered".
 * A baseline at or past the viewed version cannot be diffed, so a hand-typed
 * one degrades to the automatic baseline instead of fetching a missing
 * version — but the presentation follows the *presence* of `compare`, not its
 * usability: a link that spells out a comparison still means to compare, and
 * degrading it all the way back to rendered used to strand it on a removed
 * file's placeholder (T-203).
 */
export function specMode(
  search: SpecSearch,
  version: number,
  off: boolean,
): SpecMode {
  const pinned =
    search.compare !== undefined && search.compare < version
      ? search.compare
      : undefined;
  const baseline = pinned ?? (off || version <= 1 ? null : version - 1);
  if (baseline === null) return { baseline, view: null };
  if (search.view !== undefined) return { baseline, view: search.view };
  return {
    baseline,
    view: search.compare === undefined ? "rendered" : "source",
  };
}

/**
 * Shortest URL for a page state.
 *
 * The version is always spelled out: the page reads it from the URL alone,
 * so a push cannot change what is on screen. Reading without a baseline
 * shares the parameterless form with the automatic posture: the "off"
 * position is a session-local reading stance, deliberately not carried in a
 * shared link (T-192).
 */
export function specSearchFor({
  file,
  version,
  baseline,
  view,
}: {
  file?: string;
  /** The version being viewed. */
  version: number;
  baseline: number | null;
  view: SpecView;
}): SpecSearch {
  if (baseline === null || (baseline === version - 1 && view === "rendered")) {
    return { file, v: version };
  }
  return {
    file,
    v: version,
    compare: baseline,
    view: view === "rendered" ? "rendered" : undefined,
  };
}
