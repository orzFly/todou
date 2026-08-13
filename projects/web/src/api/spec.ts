import { queryOptions, useQuery } from "@tanstack/react-query";
import { SpecPushedPayload, TodouError } from "@todou/shared";
import { issueQuery } from "@/api/issues.ts";
import { api } from "@/api/queries.ts";
import {
  computeVersionStats,
  type SpecFileStat,
} from "@/lib/spec-version-stats.ts";

/** Spec overview; resolves null (not an error) when the issue has no spec. */
export const specQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["spec", slug, issueNumber],
    queryFn: async () => {
      try {
        return await api.getSpec(slug, issueNumber);
      } catch (error) {
        if (error instanceof TodouError && error.status === 404) return null;
        throw error;
      }
    },
  });

export const specFilesQuery = (
  slug: string,
  issueNumber: number,
  version?: number,
) =>
  queryOptions({
    // Version snapshots are immutable, so old versions can cache forever;
    // "current" (undefined) must follow pushes via SSE invalidation.
    queryKey: ["spec-files", slug, issueNumber, version ?? "current"],
    queryFn: () => api.getSpecFiles(slug, issueNumber, version),
    staleTime: version === undefined ? 5_000 : Number.POSITIVE_INFINITY,
  });

export const specCommentsQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["spec", slug, issueNumber, "comments"],
    queryFn: () => api.getSpecComments(slug, issueNumber),
  });

/**
 * The spec surfaces of the issue page, gated on the denormalized
 * `spec_version` the issue payload already carries (T-23): the page has
 * the issue in cache by the time these mount, so spec-less issues (the
 * common case) skip both the 404 probe and the spec_pushed timeline
 * query entirely. An SSE spec push invalidates the issue alongside the
 * spec keys, so the queries wake up on their own.
 */
export function useIssueSpec(slug: string, issueNumber: number) {
  const issue = useQuery(issueQuery(slug, issueNumber));
  const hasSpec = issue.data?.spec_version != null;
  const spec = useQuery({
    ...specQuery(slug, issueNumber),
    enabled: hasSpec,
  });
  const latest = useQuery({
    ...latestSpecPushQuery(slug, issueNumber),
    enabled: hasSpec,
  });
  return { spec, latest };
}

/** Newest spec_pushed timeline event — the anchor target of the issue-page
 *  spec entry (T-63) and the payload source for its stats. */
export const latestSpecPushQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["spec", slug, issueNumber, "latest-push"],
    queryFn: async () => {
      const page = await api.getTimeline(slug, issueNumber, {
        types: "spec_pushed",
        last: true,
        limit: 100,
      });
      const event = page.items.findLast((item) => item.type === "event");
      if (event === undefined || event.type !== "event") return null;
      const payload = SpecPushedPayload.safeParse(event.payload);
      return payload.success
        ? { eventId: event.id, payload: payload.data }
        : null;
    },
  });

/**
 * Per-file git stats of one push, computed from the immutable version
 * snapshots with lazily-loaded jsdiff (T-59). Shared between the timeline
 * version card and the issue-page spec surfaces — one cache entry per
 * version.
 */
export const specVersionStatsQuery = (
  slug: string,
  issueNumber: number,
  payload: SpecPushedPayload,
) =>
  queryOptions({
    queryKey: ["spec-version-stats", slug, issueNumber, payload.version],
    staleTime: Number.POSITIVE_INFINITY,
    // Version snapshots go through the query cache (they are immutable,
    // specFilesQuery caches them forever): adjacent stats queries share
    // the versions they have in common — v2's "before" is v1's "after".
    queryFn: async ({ client }): Promise<SpecFileStat[]> => {
      const [{ diffLines }, after, before] = await Promise.all([
        import("diff"),
        client.fetchQuery(specFilesQuery(slug, issueNumber, payload.version)),
        payload.version > 1
          ? client.fetchQuery(
              specFilesQuery(slug, issueNumber, payload.version - 1),
            )
          : Promise.resolve(null),
      ]);
      return computeVersionStats(
        payload,
        new Map(before?.files.map((f) => [f.path, f.body]) ?? []),
        new Map(after.files.map((f) => [f.path, f.body])),
        diffLines,
      );
    },
  });
