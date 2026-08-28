import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { MePrefs, MePrefsPatch } from "@todou/shared";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";

export const prefsQuery = queryOptions({
  queryKey: ["me-prefs"],
  queryFn: () => api.getMyPrefs(),
  // Preferences change through this tab's own toggle, almost never behind
  // our back — no point refetching on every window focus.
  staleTime: 60_000,
});

/**
 * Whether the ref leads the title wherever both are rendered (T-153).
 *
 * Still-loading prefs fall back to the schema default rather than blocking
 * the render, so only an account that turned this off can catch a frame of
 * the other order — the same trade-off `MarkReadButton` makes.
 */
export function useRefBeforeTitle(): boolean {
  return useQuery(prefsQuery).data?.ref_before_title ?? true;
}

/**
 * Optimistic preference patch (T-97): the toggle flips instantly, and the
 * inbox is invalidated alongside because the server filters weak-unread
 * rows from /me/inbox with this same preference.
 */
export function usePatchPrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: MePrefsPatch) => api.patchMyPrefs(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ["me-prefs"] });
      const before = queryClient.getQueryData<MePrefs>(["me-prefs"]);
      if (before) {
        queryClient.setQueryData<MePrefs>(["me-prefs"], {
          ...before,
          ...patch,
        });
      }
      return { before };
    },
    onError: (error, _patch, context) => {
      if (context?.before) {
        queryClient.setQueryData(["me-prefs"], context.before);
      }
      toast.error(`Could not save preferences: ${error.message}`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["me-prefs"] });
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });
}
