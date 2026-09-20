import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { MePrefs, type MePrefsPatch } from "@todou/shared";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import {
  beginRuntimeWrite,
  runtimeQueryOptions,
  settleRuntimeWrite,
  writeRuntimeData,
} from "@/api/runtime/query-adapter.ts";
import { resource } from "@/api/runtime/resources.ts";

export const prefsQuery = runtimeQueryOptions(
  queryOptions({
    queryKey: ["me-prefs"],
    queryFn: () => api.getMyPrefs(),
    // A change from another tab or device arrives as a `me` event (T-275),
    // and this tab's own toggle invalidates on settle, so the only thing a
    // focus refetch would add is a request that finds the same values.
    staleTime: 60_000,
  }),
  { kind: "direct", resources: [resource("prefs", "/me/prefs")] },
);

const PREF_DEFAULTS = MePrefs.parse({});

/** The surfaces that render a ref and a title together (T-157). */
export type RefSurface = "list" | "board" | "detail" | "reference";

/**
 * Where this surface puts the ref relative to the title. The board answers
 * with a third value, `own_line`; the rest are `before | after`.
 *
 * Still-loading prefs fall back to the schema defaults rather than blocking
 * the render, so only an account that changed a surface can catch a frame of
 * the other order — the same trade-off `MarkReadButton` makes.
 */
export function useRefPlacement<S extends RefSurface>(
  surface: S,
): MePrefs[`ref_placement_${S}`] {
  const prefs = useQuery(prefsQuery).data;
  return (prefs ?? PREF_DEFAULTS)[`ref_placement_${surface}`];
}

/** The keys that decide how a reference renders inside a body (T-371). */
type BodyRefPref = {
  [K in keyof MePrefs]: MePrefs[K] extends boolean ? K : never;
}[keyof MePrefs];

function useBodyRefPref(key: BodyRefPref): boolean {
  const prefs = useQuery(prefsQuery).data;
  return (prefs ?? PREF_DEFAULTS)[key];
}

/** Whether a markdown body draws its rich references as bordered chips. */
export function useBoxedRefLinks(): boolean {
  return useBodyRefPref("boxed_ref_links");
}

/** Whether an over-long reference title is cut to the chip's width cap. */
export function useTruncateRefTitle(): boolean {
  return useBodyRefPref("truncate_ref_title");
}

/** Whether a card named twice in one body carries its title both times. */
export function useShowRepeatedRefTitle(): boolean {
  return useBodyRefPref("show_repeated_ref_title");
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
      const ownerToken = beginRuntimeWrite(queryClient, {
        queryKey: ["me-prefs"],
      });
      try {
        await queryClient.cancelQueries({ queryKey: ["me-prefs"] });
        const before = queryClient.getQueryData<MePrefs>(["me-prefs"]);
        if (before) {
          writeRuntimeData<MePrefs>(
            queryClient,
            ["me-prefs"],
            {
              ...before,
              ...patch,
            },
            ownerToken,
          );
        }
        return { before, ownerToken };
      } catch (error) {
        await settleRuntimeWrite(queryClient, ownerToken).catch(() => {});
        throw error;
      }
    },
    onError: (error, _patch, context) => {
      if (context?.before) {
        writeRuntimeData(
          queryClient,
          ["me-prefs"],
          context.before,
          context.ownerToken,
        );
      }
      toast.error(`Could not save preferences: ${error.message}`);
    },
    onSettled: async (_data, _error, _patch, context) => {
      if (context)
        await settleRuntimeWrite(queryClient, context.ownerToken).catch(
          () => {},
        );
      queryClient.invalidateQueries({ queryKey: ["me-prefs"] });
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });
}
