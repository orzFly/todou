import { queryOptions } from "@tanstack/react-query";
import { TodouError } from "@todou/shared";
import { api } from "@/api/queries.ts";

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
