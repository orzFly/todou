import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  enumLookup,
  enumValue,
  type IssueMuteMode,
  type MuteList,
} from "@todou/shared";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
/**
 * The stored mute settings (T-372), one query for the whole account: the
 * card-detail control reads its row out of it, and the Muted page renders
 * both lists from it. Inbox uses it for the muted count. Cached, because the
 * `mutes` me-event invalidates it the moment any tab writes.
 */
export const mutesQuery = {
  queryKey: ["mutes"],
  queryFn: () => api.getMutes(),
} as const;

export const issueMuteLabels: Record<IssueMuteMode, string> = {
  forever: "Quiet until unmuted",
  until_activity: "Quiet until new activity",
};

export function muteLabelOf(mode: string): string {
  return enumLookup(
    issueMuteLabels,
    mode,
    (value) => `unknown mute mode ("${value}")`,
    "mode",
  );
}

/**
 * The setting one card carries, looked up out of the cached list.
 */
export function muteOf(
  mutes: MuteList | undefined,
  slug: string,
  number: number,
): IssueMuteMode | undefined {
  const row = mutes?.issues?.find(
    (i) => i.project.slug === slug && i.number === number,
  );
  if (row === undefined) return undefined;
  enumValue(row.mode, "mute mode");
  return row.mode;
}

/**
 * Invalidation set shared by all four writes. A mute moves rows in and out
 * of /me/inbox and repaints every list's unread dots, so the refetch set is
 * the same coarse-grained one a reads sweep uses. Project-level writes drop
 * the per-slug narrowing: every project's list can change.
 */
function invalidateAfterMute(
  queryClient: QueryClient,
  scope: "issue" | "project",
  slug?: string,
): void {
  const keys: ReadonlyArray<ReadonlyArray<unknown>> = [
    ["mutes"],
    ["inbox"],
    scope === "issue" ? ["issues", slug] : ["issues"],
  ];
  for (const key of keys) queryClient.invalidateQueries({ queryKey: key });
}

export function useMuteIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; number: number; mode: IssueMuteMode }) =>
      api.muteIssue(vars.slug, vars.number, { mode: vars.mode }),
    onError: (error) =>
      toast.error("Muting failed", { description: String(error) }),
    onSettled: (_d, _e, vars) =>
      invalidateAfterMute(queryClient, "issue", vars.slug),
  });
}

export function useUnmuteIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; number: number }) =>
      api.unmuteIssue(vars.slug, vars.number),
    onError: (error) =>
      toast.error("Unmuting failed", { description: String(error) }),
    onSettled: (_d, _e, vars) =>
      invalidateAfterMute(queryClient, "issue", vars.slug),
  });
}

export function useMuteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string }) => api.muteProject(vars.slug),
    onError: (error) =>
      toast.error("Muting the project failed", { description: String(error) }),
    onSettled: () => invalidateAfterMute(queryClient, "project"),
  });
}

export function useUnmuteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string }) => api.unmuteProject(vars.slug),
    onError: (error) =>
      toast.error("Unmuting the project failed", {
        description: String(error),
      }),
    onSettled: () => invalidateAfterMute(queryClient, "project"),
  });
}
