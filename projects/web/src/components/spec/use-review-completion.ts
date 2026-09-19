import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { enumLookup, type SpecReviewResult, type SpecReviewVerdict } from "@todou/shared";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { meQuery } from "@/api/queries.ts";
import { invalidateSpecState, specQuery } from "@/api/spec.ts";
import { prepareSpecReviewTarget } from "@/api/spec-review-target.ts";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import type { ReturnLinkState } from "@/lib/return-view-history.ts";
import { eventAnchor } from "@/lib/timeline-anchors.ts";

const REVIEW_VERDICT_LABELS: Record<SpecReviewVerdict, string> = {
  approve: "Approved",
  request_changes: "Requested changes on",
  comment: "Commented on",
};

export function specReviewVerdictLabel(verdict: string): string {
  return enumLookup(
    REVIEW_VERDICT_LABELS,
    verdict,
    (value) => `Reviewed ("${value}")`,
    "verdict",
  );
}

export type ReviewCompletion = {
  isCurrent: () => boolean;
  complete: (result: SpecReviewResult, settle: () => void) => Promise<void>;
};

/** Captures the owner before POST; both submit paths hold their lock until settle. */
export function useReviewCompletion(slug: string, issueNumber: number) {
  const queryClient = useQueryClient();
  // Standalone embeds may have no router. Production and navigation tests
  // always do; a committed review can still settle in an embed.
  const router = useRouter({ warn: false });
  const returnState = useReturnLinkState();
  const owner = useMemo(
    () => ({ mounted: false, generation: 0, slug, issueNumber }),
    [slug, issueNumber],
  );
  useEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
    };
  }, [owner]);
  const identity = useRef({ slug, issueNumber });
  identity.current = { slug, issueNumber };

  return useCallback(
    (options?: {
      isOwner?: () => boolean;
      returnState?: ReturnLinkState;
    }): ReviewCompletion => {
      const generation = ++owner.generation;
      const pathname = router?.state.location.pathname;
      const viewerId = queryClient.getQueryData(meQuery.queryKey)?.id;
      const specKey = specQuery(slug, issueNumber).queryKey;
      const specRevision = queryClient.getQueryState(specKey)?.dataUpdateCount;
      const state = options?.returnState ?? returnState;
      const isCurrent = () =>
        owner.mounted &&
        owner.generation === generation &&
        identity.current.slug === slug &&
        identity.current.issueNumber === issueNumber &&
        router?.state.location.pathname === pathname &&
        (options?.isOwner?.() ?? true);

      return {
        isCurrent,
        complete: async (result, settle) => {
          let label: string;
          try {
            label = specReviewVerdictLabel(result.verdict);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Invalid review verdict");
            settle();
            return;
          }
          // Start the bounded wait at the successful POST, before any cache
          // refresh can consume its budget. Its rejection cannot fail the POST.
          const targetPromise = prepareSpecReviewTarget({
            queryClient,
            slug,
            issueNumber,
            result,
            isCurrent,
          }).catch(() => ({ status: "not-found" as const }));
          queryClient.setQueryData(specKey, (info) => {
            if (
              // A GET received while POST was in flight may already include
              // another reviewer's new round. An older verdict must not
              // overwrite it, even if structural sharing kept the same data.
              queryClient.getQueryState(specKey)?.dataUpdateCount !==
                specRevision ||
              !info ||
              info.current_version !== result.version ||
              viewerId === undefined ||
              queryClient.getQueryData(meQuery.queryKey)?.id !== viewerId ||
              info.viewer_review?.user_id !== viewerId ||
              result.verdict === "comment"
            )
              return info;
            return {
              ...info,
              viewer_review: {
                user_id: viewerId,
                approved_in_current_round: result.verdict === "approve",
              },
            };
          });
          void invalidateSpecState(queryClient, slug, issueNumber).catch(
            () => {},
          );
          const target = await targetPromise;
          let settled = true;
          try {
            settle();
          } catch {
            // Consumer UI cleanup cannot turn a committed POST into a failure.
            settled = false;
          }
          toast.success(
            `${label} spec v${result.version}`,
          );
          if (
            !settled ||
            !router ||
            target.status !== "found" ||
            !target.canNavigate()
          )
            return;
          try {
            await router.navigate({
              to: "/projects/$slug/issues/$number",
              params: { slug, number: String(issueNumber) },
              search: {},
              hash: eventAnchor(result.event_id),
              hashScrollIntoView: false,
              state,
            });
          } catch {
            // A blocked/failed navigation does not undo a committed review.
          }
        },
      };
    },
    [issueNumber, owner, queryClient, returnState, router, slug],
  );
}
