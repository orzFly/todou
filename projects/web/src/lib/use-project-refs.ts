import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { referenceDirectoryQuery } from "@/api/references.ts";
import {
  type NamedProject,
  type ProjectRefOption,
  projectSpellings,
} from "@/lib/project-spellings.ts";

/**
 * Each project's spellings, by slug, for the lists that show a REF.
 *
 * The directory rather than any one project's own config, because a prefix is
 * a claim with a lifetime and can be contested: the project still names it in
 * its config while the directory has it pointing nowhere. A list cannot fetch
 * a config per project anyway, and one prefix showing in the breadcrumb while
 * it is missing from the switcher two pixels away is worse than either rule
 * alone.
 *
 * While the directory loads, or when it fails, this is empty — every project
 * reads as having no prefix, which is what the lists looked like before.
 */
export function useProjectRefs(
  projects: readonly NamedProject[] | undefined,
): Map<string, ProjectRefOption> {
  const directory = useQuery(referenceDirectoryQuery);
  return useMemo(
    () =>
      new Map(
        projectSpellings(projects, directory.data).map((o) => [o.slug, o]),
      ),
    [projects, directory.data],
  );
}
