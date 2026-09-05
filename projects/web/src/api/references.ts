import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  DEFAULT_REFERENCE_CONFIG,
  type ReferenceConfig,
  type ReferenceDirectory,
  refPrefixAt,
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
 * Tokenizer config for content anchored at `refDate` (T-80 time cutoff):
 * the internal format is the one in force when the content was created,
 * autolinks are always the current rule set. No date = "now" (UI strings,
 * editor previews). Omitting `cross` leaves the cross-project grammar off,
 * which is what UI-spelled strings want — they are never user prose.
 */
export function refConfigFor(
  config: ReferenceConfig | undefined,
  refDate?: string,
  cross?: CrossRefInputs,
): RefConfig {
  const base = {
    internalPrefix:
      config === undefined
        ? null
        : refDate === undefined
          ? config.format.prefix
          : refPrefixAt(config.format.history, refDate),
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
      ...(refDate === undefined ? {} : { at: refDate }),
    },
  };
}
