/** Why a project is in a filtered list, and where to paint that reason. */
export type ProjectMatch = {
  field: "name" | "slug" | "prefix";
  /**
   * UTF-16 range into that field's own text; null where the hit stands but
   * cannot be located safely.
   */
  range: { start: number; end: number } | null;
};

/** `undefined` = no hit; `null` = hit, nowhere safe to paint it. */
function hit(
  text: string,
  needle: string,
): { start: number; end: number } | null | undefined {
  const lowered = text.toLowerCase();
  const start = lowered.indexOf(needle);
  if (start < 0) return undefined;
  // Case folding that changes length puts every offset past it out of step
  // with the original: `"İ".toLowerCase()` is two characters, so a range
  // measured on the folded string would paint the neighbouring glyph. Slugs
  // and prefixes cannot reach this (`[a-z0-9-]` and `[A-Z0-9_]` both fold to
  // the same length); a name is arbitrary text and can.
  if (lowered.length !== text.length) return null;
  return { start, end: start + needle.length };
}

/**
 * The first reason this project answers `query`, or null if it does not.
 *
 * One reason, not all of them: the segment this paints means "why is this row
 * here", and a second reason would cost a second segment in a 300px panel.
 *
 * Null means only that the project does not match. An empty query never
 * reaches here — the caller shows the whole list instead — because folding
 * "no filter" and "filtered out" onto one return value makes every call site
 * re-test the query anyway.
 */
export function matchProject(
  project: { name: string; slug: string; prefix: string | null },
  query: string,
): ProjectMatch | null {
  const q = query.trim().toLowerCase();

  const name = hit(project.name, q);
  if (name !== undefined) return { field: "name", range: name };
  const slug = hit(project.slug, q);
  if (slug !== undefined) return { field: "slug", range: slug };

  if (project.prefix === null) return null;
  // Shown bare (`CH`), but the reader may be holding one picked out of a card
  // number, where it comes with the hyphen still attached.
  const bare = q.replace(/-+$/, "");
  if (bare === "") return null;
  const prefix = hit(project.prefix, bare);
  return prefix === undefined ? null : { field: "prefix", range: prefix };
}
