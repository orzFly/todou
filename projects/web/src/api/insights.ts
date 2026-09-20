import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { type BurnQuery, type PutSettings, TodouError } from "@todou/shared";
import { insightsKeys } from "@/api/insights-keys.ts";
import { api } from "@/api/queries.ts";

export { insightsKeys } from "@/api/insights-keys.ts";

export const insightsSettingsQuery = (slug: string) =>
  queryOptions({
    queryKey: insightsKeys.settings(slug),
    queryFn: () => api.getInsightsSettings(slug),
    staleTime: 60_000,
  });

export function insightsBurnQuery(
  slug: string,
  request: BurnQuery,
  settingsVersion: string,
) {
  // Snapshot the request so later caller edits cannot change the fetch while
  // leaving its key describing a different range.
  const input = { ...request };
  return queryOptions({
    queryKey: insightsKeys.burnRequest(slug, input, settingsVersion),
    queryFn: () => api.getInsightsBurn(slug, input),
  });
}

/** Settings change the interpretation of every range, not just the open one. */
export async function invalidateInsights(
  queryClient: QueryClient,
  slug: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: insightsKeys.settings(slug) }),
    queryClient.invalidateQueries({ queryKey: insightsKeys.burn(slug) }),
  ]);
}

export const updateInsightsSettingsMutation = (
  queryClient: QueryClient,
  slug: string,
) =>
  mutationOptions({
    mutationFn: (input: PutSettings) => api.updateInsightsSettings(slug, input),
    onSuccess: () => invalidateInsights(queryClient, slug),
    // A stale optimistic-concurrency version needs fresh settings as well.
    onError: (error) => {
      if (error instanceof TodouError && error.status === 409) {
        return invalidateInsights(queryClient, slug);
      }
    },
  });
