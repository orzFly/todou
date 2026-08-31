/**
 * The spec page's URL model: which version is on screen, what it is compared
 * against, and how that comparison is drawn (T-192).
 *
 * Kept out of the page module so the route table can validate the search
 * params without pulling @pierre/diffs into the main bundle.
 */

export type SpecView = "rendered" | "source";

export type SpecSearch = {
  file?: string;
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
  view: SpecView;
};

/**
 * Resolves the two orthogonal controls from the URL.
 *
 * A pinned `compare` with no `view` is a link written before the split, and
 * every one of those opened the source diff — so that stays the default,
 * while an absent `compare` keeps meaning "previous version, rendered".
 * A baseline at or past the viewed version cannot be diffed, so a hand-typed
 * one degrades to the automatic baseline instead of fetching a missing
 * version.
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
  if (baseline === null) return { baseline, view: "rendered" };
  if (search.view !== undefined) return { baseline, view: search.view };
  return { baseline, view: pinned === undefined ? "rendered" : "source" };
}

/**
 * Shortest URL for a page state.
 *
 * Reading without a baseline shares the parameterless form with the
 * automatic posture: the "off" position is a session-local reading stance,
 * deliberately not carried in a shared link (T-192).
 */
export function specSearchFor({
  file,
  v,
  version,
  baseline,
  view,
}: {
  file?: string;
  /** The `v` param as it stands — absent means "whatever is current". */
  v?: number;
  /** The version being viewed, `v` already resolved. */
  version: number;
  baseline: number | null;
  view: SpecView;
}): SpecSearch {
  if (baseline === null || (baseline === version - 1 && view === "rendered")) {
    return { file, v };
  }
  return {
    file,
    v,
    compare: baseline,
    view: view === "rendered" ? "rendered" : undefined,
  };
}
