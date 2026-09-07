import type { Project, ReferenceDirectory } from "@todou/shared";

/** A project in the completion pool, with its equivalent spellings ranked. */
export type ProjectRefOption = {
  slug: string;
  /** The project's name, the short grey note at the end of the line. */
  name: string;
  /**
   * Insertable spellings, best first: `["ACC-", "accel/"]` where there is a
   * prefix, `["homelab/"]` where there is not.
   */
  spellings: string[];
};

/**
 * How each project can be named, best spelling first (T-263). The prefix
 * form comes first because it is the shorter of two synonyms and the one a
 * card number attaches to directly.
 *
 * Retired claims are left out on purpose. They still *resolve* — someone
 * typing a project's old name from memory is exactly who `resolveSlugAt`
 * exists for — but a completion teaches a spelling, and there is no reason
 * to teach one that is on its way out. A contested prefix is left out for a
 * stronger reason: it resolves to nothing at all.
 *
 * The search box and the markdown editors share this pool so that one query
 * reaches the same projects in both, under the same exclusions and the same
 * ranking.
 */
export function projectSpellings(
  projects: readonly Project[] | undefined,
  directory: ReferenceDirectory | null | undefined,
): ProjectRefOption[] {
  if (projects === undefined) return [];
  const now = Date.now();
  const covers = (from: string, to: string | null) =>
    Date.parse(from) <= now && (to === null || now < Date.parse(to));
  const pool = projects.map((project) => {
    const claim = directory?.entries.find(
      (entry) => entry.slug === project.slug && covers(entry.from, entry.to),
    );
    const usable =
      claim !== undefined &&
      !(directory?.contested ?? []).some(
        (fight) =>
          fight.prefix === claim.prefix && covers(fight.from, fight.to),
      );
    return {
      slug: project.slug,
      name: project.name,
      spellings: usable
        ? [`${(claim as { prefix: string }).prefix}-`, `${project.slug}/`]
        : [`${project.slug}/`],
    };
  });
  // `GET /api/projects` has no ORDER BY, so without this the rows would sit
  // in whatever order the database happened to return.
  return pool.sort((a, b) => a.slug.localeCompare(b.slug));
}
