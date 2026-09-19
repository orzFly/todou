import { useQueryClient } from "@tanstack/react-query";
import { useMatches } from "@tanstack/react-router";
import {
  type SpecReviewSubmitInput,
  type SpecReviewVerdict,
  TodouError,
} from "@todou/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { api, meQuery } from "@/api/queries.ts";
import {
  invalidateSpecState,
  specQuery,
  viewerApprovedCurrentRound,
} from "@/api/spec.ts";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { useReviewCompletion } from "@/components/spec/use-review-completion.ts";
import type { ReturnLinkState } from "@/lib/return-view-history.ts";
import {
  confirmSubmittedSpecReviewDrafts,
  type SpecReviewDraft,
} from "@/lib/spec-drafts.ts";
import {
  createSpecReviewSession,
  isCurrentSpecReviewSession,
  type SpecReviewSession,
  type SpecReviewSessionSnapshot,
  specReviewSessionSurvivesNavigation,
} from "@/lib/spec-review-session.ts";
import { type NavigationContext, useDirtySource } from "@/lib/unsaved-guard.ts";

const SPEC_ROUTE_ID = "/authed/projects/$slug/issues/$number/spec";

type SubmitReviewInput = {
  currentVersion: number;
  verdict: SpecReviewVerdict;
  drafts: SpecReviewDraft[];
  returnState?: ReturnLinkState;
};

type SpecReviewSessionContextValue = {
  session: SpecReviewSession;
  submitReview: (input: SubmitReviewInput) => void;
};

const SpecReviewSessionContext =
  createContext<SpecReviewSessionContextValue | null>(null);

function submitComments(
  drafts: SpecReviewDraft[],
): SpecReviewSubmitInput["comments"] {
  return drafts.map((draft) => ({
    anchor: {
      path: draft.anchor.path,
      version: draft.anchor.version,
      ...(draft.anchor.line_start !== null && draft.anchor.line_end !== null
        ? {
            line_start: draft.anchor.line_start,
            line_end: draft.anchor.line_end,
          }
        : {}),
      ...(draft.anchor.col_start !== null && draft.anchor.col_end !== null
        ? {
            col_start: draft.anchor.col_start,
            col_end: draft.anchor.col_end,
          }
        : {}),
    },
    body: draft.body,
  }));
}

function SessionOwner({
  slug,
  issueNumber,
  children,
}: {
  slug: string;
  issueNumber: number;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const beginCompletion = useReviewCompletion(slug, issueNumber);
  const session = useMemo(
    () => createSpecReviewSession({ slug, issueNumber }),
    [slug, issueNumber],
  );
  useEffect(() => session.connect(), [session]);
  const survivesNavigation = useCallback(
    (navigation: NavigationContext) =>
      specReviewSessionSurvivesNavigation({ slug, issueNumber }, navigation),
    [slug, issueNumber],
  );
  useDirtySource(session.isDirty, survivesNavigation);

  const submitReview = useCallback(
    ({ currentVersion, verdict, drafts, returnState }: SubmitReviewInput) => {
      const state = session.getSnapshot();
      if (state.pending !== null) return;
      const version = state.reviewVersion ?? currentVersion;
      const latest = queryClient.getQueryData(
        specQuery(slug, issueNumber).queryKey,
      );
      if (latest && latest.current_version !== version) {
        toast.error(
          `Spec v${version} is no longer current. Your review draft has been kept.`,
        );
        return;
      }
      if (latest?.review_status === "withdrawn" && verdict !== "comment") {
        toast.error(`Spec v${version} has been withdrawn.`);
        return;
      }
      if (
        verdict === "approve" &&
        viewerApprovedCurrentRound(
          latest,
          queryClient.getQueryData(meQuery.queryKey)?.id,
          version,
        )
      ) {
        toast.error(
          `You already approved spec v${version} in the current review round.`,
        );
        return;
      }

      const submittedDrafts = drafts.map((draft) => ({
        ...draft,
        anchor: { ...draft.anchor },
      }));
      const submittedSummary = state.summary;
      const body = submittedSummary.trim();
      const pending = session.beginSubmit(verdict);
      if (pending === null) return;
      const completion = beginCompletion({
        isOwner: () => isCurrentSpecReviewSession(state.identity, state.token),
        returnState,
      });

      void api
        .submitSpecReview(slug, issueNumber, {
          version,
          verdict,
          ...(body === "" ? {} : { body }),
          comments: submitComments(submittedDrafts),
        })
        .then(
          (result) => {
            confirmSubmittedSpecReviewDrafts(
              slug,
              issueNumber,
              submittedDrafts,
            );
            return completion.complete(result, () => {
              session.finishSubmit(pending.id, submittedSummary);
            });
          },
          (error: unknown) => {
            session.failSubmit(pending.id);
            if (error instanceof TodouError && error.status === 409) {
              void invalidateSpecState(queryClient, slug, issueNumber);
            }
            if (isCurrentSpecReviewSession(state.identity, state.token)) {
              toast.error(
                error instanceof Error ? error.message : "Review failed",
              );
            }
          },
        );
    },
    [beginCompletion, issueNumber, queryClient, session, slug],
  );

  const value = useMemo(
    () => ({ session, submitReview }),
    [session, submitReview],
  );
  return (
    <SpecReviewSessionContext.Provider value={value}>
      {children}
    </SpecReviewSessionContext.Provider>
  );
}

/** Holds the current spec's transient review inputs outside page Suspense. */
export function SpecReviewSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const slug = useMatches({
    select: (matches) =>
      matches.find((match) => match.routeId === SPEC_ROUTE_ID)?.params.slug,
  });
  const rawNumber = useMatches({
    select: (matches) =>
      matches.find((match) => match.routeId === SPEC_ROUTE_ID)?.params.number,
  });
  const issueNumber = Number(rawNumber);

  if (typeof slug !== "string" || !Number.isInteger(issueNumber)) {
    return children;
  }
  return (
    <SessionOwner
      key={`${slug}:${issueNumber}`}
      slug={slug}
      issueNumber={issueNumber}
    >
      {children}
    </SessionOwner>
  );
}

/**
 * Standalone spec renderers (focused tests and embeds) get the same contract.
 * The application already owns a session above Suspense, so this is a no-op
 * there rather than a second owner.
 */
export function SpecReviewSessionScope({
  slug,
  issueNumber,
  children,
}: {
  slug: string;
  issueNumber: number;
  children: ReactNode;
}) {
  const current = useContext(SpecReviewSessionContext);
  if (current !== null) return children;
  return (
    <SessionOwner slug={slug} issueNumber={issueNumber}>
      {children}
    </SessionOwner>
  );
}

export function useSpecReviewSession(
  slug: string,
  issueNumber: number,
): SpecReviewSessionContextValue & {
  state: SpecReviewSessionSnapshot;
} {
  const value = useContext(SpecReviewSessionContext);
  // This consumer lives below ReturnViewProvider in the shell; SessionOwner
  // intentionally lives above it so Suspense cannot reset an in-flight POST.
  const returnState = useReturnLinkState();
  const submitReview = useCallback(
    (input: SubmitReviewInput) =>
      value?.submitReview({ ...input, returnState }),
    [returnState, value],
  );
  if (
    value === null ||
    value.session.getSnapshot().identity.slug !== slug ||
    value.session.getSnapshot().identity.issueNumber !== issueNumber
  ) {
    throw new Error("Spec review session does not match the current route");
  }
  const state = useSyncExternalStore(
    value.session.subscribe,
    value.session.getSnapshot,
  );
  return { ...value, state, submitReview };
}
