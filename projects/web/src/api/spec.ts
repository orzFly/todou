import { queryOptions } from "@tanstack/react-query";
import { SpecPushedPayload, TodouError } from "@todou/shared";
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

/** Newest spec_pushed timeline event — the anchor target of the issue-page
 *  spec entry (#63) and the payload source for its stats. */
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
 * snapshots with lazily-loaded jsdiff (#59). Shared between the timeline
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
    queryFn: async (): Promise<SpecFileStat[]> => {
      const [{ diffLines }, after, before] = await Promise.all([
        import("diff"),
        api.getSpecFiles(slug, issueNumber, payload.version),
        payload.version > 1
          ? api.getSpecFiles(slug, issueNumber, payload.version - 1)
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
