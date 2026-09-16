import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/queries.ts";

/**
 * One account's public identity. 60s staleTime, the metadata cadence: the
 * login an avatar render from here follow a rename eventually, never
 * instantly, which is the same freshness a member chip gets.
 */
export const userQuery = (ref: string) =>
  queryOptions({
    queryKey: ["user", ref],
    queryFn: () => api.getUser(ref),
    staleTime: 60_000,
  });
