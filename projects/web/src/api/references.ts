import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  DEFAULT_REFERENCE_CONFIG,
  type ReferenceConfig,
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

/**
 * Tokenizer config for content anchored at `refDate` (T-80 time cutoff):
 * the internal format is the one in force when the content was created,
 * autolinks are always the current rule set. No date = "now" (UI strings,
 * editor previews).
 */
export function refConfigFor(
  config: ReferenceConfig | undefined,
  refDate?: string,
): RefConfig {
  if (config === undefined) return { internalPrefix: null, autolinks: [] };
  return {
    internalPrefix:
      refDate === undefined
        ? config.format.prefix
        : refPrefixAt(config.format.history, refDate),
    autolinks: config.autolinks,
  };
}
