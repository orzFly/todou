import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  DEFAULT_REFERENCE_CONFIG,
  type ReferenceConfig,
  type ReferenceDirectory,
} from "@todou/shared";
import { api } from "@/api/queries.ts";
import type { RefConfig } from "@/lib/issue-refs.ts";

export const referenceConfigQuery = (slug: string) =>
  queryOptions({
    queryKey: ["reference-config", slug],
    queryFn: async (): Promise<ReferenceConfig> => {
      try {
        return await api.getReferenceConfig(slug);
      } catch (error) {
        // Servers predating T-80 have no endpoint; degrade to the
        // built-in behaviour instead of breaking every markdown view.
        if ((error as { status?: number }).status === 404)
          return DEFAULT_REFERENCE_CONFIG;
        throw error;
      }
    },
    // Refs are decoration; trade freshness for fewer refetch bursts.
    staleTime: 60_000,
  });

export const referenceDirectoryQuery = queryOptions({
  queryKey: ["reference-directory"],
  queryFn: async (): Promise<ReferenceDirectory | null> => {
    try {
      return await api.getReferenceDirectory();
    } catch (error) {
      // Servers predating T-150 have no endpoint; without a directory
      // nothing foreign resolves, and this project's own forms carry on.
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  },
  staleTime: 60_000,
});

/**
 * The project's current reference prefix, for UI-spelled ref strings
 * (headings, list rows, document titles). null while loading — the
 * spelling briefly degrades to "#N", never blocks.
 */
export function useRefPrefix(slug: string | undefined): string | null {
  const query = useQuery({
    ...referenceConfigQuery(slug ?? ""),
    enabled: slug !== undefined,
  });
  return query.data?.format.prefix ?? null;
}

/** What the cross-project half of the grammar needs from the viewer's session. */
export type CrossRefInputs = {
  /** Slugs the viewer can read; a qualified form naming anything else stays literal. */
  slugs: string[];
  directory: ReferenceDirectory;
};

/**
 * Tokenizer config as of now: the project's current format and its current
 * autolink rules.
 *
 * There is no content date any more (T-266). A reference is resolved when it
 * is submitted, so the only text a tokenizer still runs over is a draft
 * nobody has saved — and a draft is being written at this instant, under
 * this project. Omitting `cross` leaves the cross-project grammar off, which
 * is what UI-spelled strings want: they are never user prose.
 */
export function refConfigFor(
  config: ReferenceConfig | undefined,
  cross?: CrossRefInputs,
): RefConfig {
  const base = {
    internalPrefix: config?.format.prefix ?? null,
    autolinks: config?.autolinks ?? [],
  };
  if (cross === undefined) return base;
  return {
    ...base,
    cross: {
      slugs: cross.slugs,
      directory: cross.directory,
      // Absent on a pre-T-156 server, and an empty list resolves exactly
      // like no history at all.
      slugEntries: cross.directory.slug_entries ?? [],
    },
  };
}
