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
  reviewVersion: number | null;
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
  setFinishOpen: (open: boolean, version?: number, hasDrafts?: boolean) => void;
  beginSubmit: (verdict: SpecReviewVerdict) => PendingSpecReview | null;
  finishSubmit: (pendingId: number, submittedSummary: string) => void;
  failSubmit: (pendingId: number) => void;
  connect: () => () => void;
};

let nextSessionNumber = 0;
let nextSubmitNumber = 0;

const latestToken = new Map<string, symbol>();

const identityKey = (identity: SpecReviewIdentity) =>
  `${identity.slug}:${identity.issueNumber}`;

type PendingStore = {
  pending: PendingSpecReview | null;
  listeners: Set<(pending: PendingSpecReview | null) => void>;
};

const pendingStores = new Map<string, PendingStore>();

function pendingStore(identity: SpecReviewIdentity): PendingStore {
  const key = identityKey(identity);
  const existing = pendingStores.get(key);
  if (existing !== undefined) return existing;
  const created: PendingStore = { pending: null, listeners: new Set() };
  pendingStores.set(key, created);
  return created;
}

function releasePending(
  identity: SpecReviewIdentity,
  store: PendingStore,
  pendingId: number,
): boolean {
  if (store.pending?.id !== pendingId) return false;
  store.pending = null;
  for (const notify of store.listeners) notify(null);
  if (
    store.listeners.size === 0 &&
    pendingStores.get(identityKey(identity)) === store
  ) {
    pendingStores.delete(identityKey(identity));
  }
  return true;
}

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
  const listeners = new Set<() => void>();
  let sharedPending = pendingStore(identity);
  let baseline: ComposerBaseline | null = null;
  let snapshot: SpecReviewSessionSnapshot = {
    identity,
    token,
    staging: null,
    composerBody: "",
    summary: "",
    finishOpen: false,
    reviewVersion: null,
    pending: sharedPending.pending,
  };

  const update = (
    patch: Partial<Omit<SpecReviewSessionSnapshot, "identity" | "token">>,
  ) => {
    snapshot = { ...snapshot, ...patch };
    for (const notify of listeners) notify();
  };
  const syncPending = (pending: PendingSpecReview | null) => {
    update({ pending });
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
    setFinishOpen: (finishOpen, version, hasDrafts = false) => {
      // A failed review keeps its original target even after a push or a
      // close/reopen. An empty form may start a fresh review of the new version.
      const retainVersion =
        snapshot.summary.trim() !== "" ||
        hasDrafts ||
        snapshot.pending !== null;
      update({
        finishOpen,
        ...(finishOpen && version !== undefined
          ? {
              reviewVersion:
                retainVersion && snapshot.reviewVersion !== null
                  ? snapshot.reviewVersion
                  : version,
            }
          : {}),
      });
    },
    beginSubmit: (verdict) => {
      if (sharedPending.pending !== null) return null;
      const pending = { id: ++nextSubmitNumber, verdict };
      sharedPending.pending = pending;
      for (const notify of sharedPending.listeners) notify(pending);
      if (snapshot.pending?.id !== pending.id) update({ pending });
      return pending;
    },
    finishSubmit: (pendingId, submittedSummary) => {
      if (!releasePending(identity, sharedPending, pendingId)) return;
      const summaryUnchanged = snapshot.summary === submittedSummary;
      update({
        pending: null,
        ...(summaryUnchanged
          ? { summary: "", finishOpen: false, reviewVersion: null }
          : {}),
      });
    },
    failSubmit: (pendingId) => {
      if (
        releasePending(identity, sharedPending, pendingId) &&
        snapshot.pending?.id === pendingId
      ) {
        update({ pending: null });
      }
    },
    connect: () => {
      latestToken.set(identityKey(identity), token);
      // StrictMode reconnects every effect once. Rejoin the canonical store
      // in case the first cleanup retired an empty one.
      sharedPending = pendingStore(identity);
      const connected = sharedPending;
      connected.listeners.add(syncPending);
      syncPending(connected.pending);
      return () => {
        connected.listeners.delete(syncPending);
        queueMicrotask(() => {
          if (
            connected.pending === null &&
            connected.listeners.size === 0 &&
            pendingStores.get(identityKey(identity)) === connected
          ) {
            pendingStores.delete(identityKey(identity));
          }
        });
      };
    },
  };
}
