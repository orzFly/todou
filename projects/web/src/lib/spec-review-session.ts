import type { SpecReviewVerdict } from "@todou/shared";
import type { ComposerStaging } from "@/components/spec/spec-composer.tsx";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";
import { beginEdit, retarget, type Staging } from "@/lib/spec-staging.ts";
import type { NavigationContext } from "@/lib/unsaved-guard.ts";

const SPEC_ROUTE_ID = "/authed/projects/$slug/issues/$number/spec";

export type SpecReviewIdentity = {
  slug: string;
  issueNumber: number;
};

export function specReviewSessionSurvivesNavigation(
  identity: SpecReviewIdentity,
  navigation: NavigationContext,
): boolean {
  const isThisSpec = (location: NavigationContext["current"]) =>
    location.routeId === SPEC_ROUTE_ID &&
    location.params.slug === identity.slug &&
    Number(location.params.number) === identity.issueNumber;
  return isThisSpec(navigation.current) && isThisSpec(navigation.next);
}

export type PendingSpecReview = {
  id: number;
  verdict: SpecReviewVerdict;
};

type ComposerBaseline = {
  body: string;
  staging: Staging;
};

export type SpecReviewSessionSnapshot = {
  identity: SpecReviewIdentity;
  token: symbol;
  staging: Staging | null;
  composerBody: string;
  summary: string;
  finishOpen: boolean;
  pending: PendingSpecReview | null;
};

export type SpecReviewSession = {
  getSnapshot: () => SpecReviewSessionSnapshot;
  subscribe: (notify: () => void) => () => void;
  isDirty: () => boolean;
  retarget: (next: ComposerStaging) => void;
  editDraft: (draft: SpecReviewDraft) => void;
  setComposerBody: (body: string) => void;
  clearComposer: () => void;
  setSummary: (summary: string) => void;
  setFinishOpen: (open: boolean) => void;
  beginSubmit: (verdict: SpecReviewVerdict) => PendingSpecReview;
  finishSubmit: (pendingId: number, submittedSummary: string) => void;
  failSubmit: (pendingId: number) => void;
};

let nextSessionNumber = 0;
let nextSubmitNumber = 0;

const latestToken = new Map<string, symbol>();

const identityKey = (identity: SpecReviewIdentity) =>
  `${identity.slug}:${identity.issueNumber}`;

export function isCurrentSpecReviewSession(
  identity: SpecReviewIdentity,
  token: symbol,
): boolean {
  return latestToken.get(identityKey(identity)) === token;
}

function sameAnchor(left: Staging, right: Staging): boolean {
  return (
    left.path === right.path &&
    left.version === right.version &&
    left.lineStart === right.lineStart &&
    left.lineEnd === right.lineEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd &&
    left.quote === right.quote
  );
}

export function createSpecReviewSession(
  identity: SpecReviewIdentity,
): SpecReviewSession {
  const token = Symbol(`${identity.slug}:${identity.issueNumber}`);
  latestToken.set(identityKey(identity), token);
  const listeners = new Set<() => void>();
  let baseline: ComposerBaseline | null = null;
  let snapshot: SpecReviewSessionSnapshot = {
    identity,
    token,
    staging: null,
    composerBody: "",
    summary: "",
    finishOpen: false,
    pending: null,
  };

  const update = (
    patch: Partial<Omit<SpecReviewSessionSnapshot, "identity" | "token">>,
  ) => {
    snapshot = { ...snapshot, ...patch };
    for (const notify of listeners) notify();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    isDirty: () => {
      const { staging, composerBody, summary, pending } = snapshot;
      if (pending !== null || summary.trim() !== "") return true;
      if (staging === null) return false;
      if (baseline === null) return composerBody.trim() !== "";
      return (
        composerBody.trim() !== baseline.body.trim() ||
        !sameAnchor(staging, baseline.staging)
      );
    },
    retarget: (next) => {
      const session = ++nextSessionNumber;
      const staging = retarget(snapshot.staging, next, session);
      if (snapshot.staging === null) baseline = null;
      update({ staging });
    },
    editDraft: (draft) => {
      const staging = beginEdit(draft, ++nextSessionNumber);
      baseline = { body: draft.body, staging };
      update({ staging, composerBody: draft.body });
    },
    setComposerBody: (composerBody) => update({ composerBody }),
    clearComposer: () => {
      baseline = null;
      update({ staging: null, composerBody: "" });
    },
    setSummary: (summary) => update({ summary }),
    setFinishOpen: (finishOpen) => update({ finishOpen }),
    beginSubmit: (verdict) => {
      const pending = { id: ++nextSubmitNumber, verdict };
      update({ pending });
      return pending;
    },
    finishSubmit: (pendingId, submittedSummary) => {
      if (snapshot.pending?.id !== pendingId) return;
      const summaryUnchanged = snapshot.summary === submittedSummary;
      update({
        pending: null,
        ...(summaryUnchanged ? { summary: "", finishOpen: false } : {}),
      });
    },
    failSubmit: (pendingId) => {
      if (snapshot.pending?.id === pendingId) update({ pending: null });
    },
  };
}
