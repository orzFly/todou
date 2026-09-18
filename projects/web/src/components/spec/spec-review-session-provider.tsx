import { useQueryClient } from "@tanstack/react-query";
import { useMatches } from "@tanstack/react-router";
import type { SpecReviewSubmitInput, SpecReviewVerdict } from "@todou/shared";
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
import { api } from "@/api/queries.ts";
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
    ({ currentVersion, verdict, drafts }: SubmitReviewInput) => {
      const state = session.getSnapshot();
      if (state.pending !== null) return;

      const submittedDrafts = drafts.map((draft) => ({
        ...draft,
        anchor: { ...draft.anchor },
      }));
      const submittedSummary = state.summary;
      const body = submittedSummary.trim();
      const pending = session.beginSubmit(verdict);
      if (pending === null) return;

      void api
        .submitSpecReview(slug, issueNumber, {
          version: currentVersion,
          verdict,
          ...(body === "" ? {} : { body }),
          comments: submitComments(submittedDrafts),
        })
        .then((result) => {
          toast.success(
            `${
              {
                approve: "Approved",
                request_changes: "Requested changes on",
                comment: "Commented on",
              }[result.verdict]
            } spec v${result.version}`,
          );
          confirmSubmittedSpecReviewDrafts(slug, issueNumber, submittedDrafts);
          session.finishSubmit(pending.id, submittedSummary);
          for (const key of [
            ["spec", slug, issueNumber],
            ["timeline", slug, issueNumber],
            ["issue", slug, issueNumber],
            ["issues", slug],
          ]) {
            void queryClient.invalidateQueries({ queryKey: key });
          }
        })
        .catch((error: unknown) => {
          session.failSubmit(pending.id);
          if (isCurrentSpecReviewSession(state.identity, state.token)) {
            toast.error(
              error instanceof Error ? error.message : "Review failed",
            );
          }
        });
    },
    [issueNumber, queryClient, session, slug],
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
  return { ...value, state };
}
