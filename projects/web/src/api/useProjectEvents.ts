import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ChangeEvent,
  ChangeEvent as ChangeEventSchema,
  SSE_CHANGE_EVENT,
  SSE_PING_EVENT,
} from "@todou/shared";
import { useEffect } from "react";
import { api } from "@/api/queries.ts";

type QueryKeyLike = ReadonlyArray<unknown>;

/**
 * "refetch" re-fetches every active query under the key (the classic
 * broad invalidation). `contains` marks everything under the key stale but
 * only re-fetches pages that actually hold the issue.
 *
 * Narrowing timeline events this way is safe only because the server pairs
 * every activity that bumps `updated_at` — comment, attachment, answered
 * question, spec push, spec review (T-101) — with an `issue` event, and a
 * broad refetch subsumes a `contains` on the same key inside one coalescing
 * window. Timeline entries that arrive unpaired (`referenced`, a comment
 * edit or delete) deliberately do not bump, so they cannot move a row
 * between board columns or reorder an updated-sorted list, and pages
 * without the row have nothing visible to change.
 */
export type InvalidationScope = "refetch" | { contains: number };
export type Invalidation = { key: QueryKeyLike; scope: InvalidationScope };

const refetch = (key: QueryKeyLike): Invalidation => ({
  key,
  scope: "refetch",
});

/**
 * Pointer event → invalidation descriptors. Exported pure for tests.
 * Events carry no data, so every mapping ends in a refetch through the
 * authorized API.
 */
export function invalidationsFor(
  event: ChangeEvent,
  slug: string,
): Invalidation[] {
  switch (event.entity) {
    case "issue":
      return event.issue_number === undefined
        ? [refetch(["issues", slug])]
        : [
            // Status may have changed and the target board column is not
            // derivable from the event — stay broad.
            refetch(["issues", slug]),
            refetch(["issue", slug, event.issue_number]),
            refetch(["timeline", slug, event.issue_number]),
          ];
    case "comment":
    case "timeline":
      // Question components and their answers ride the timeline, so the
      // per-issue question status (T-19) goes stale with it — as do the
      // unread markers (T-46), which travel in the list payload. List
      // ordering is the paired issue event's job; see InvalidationScope.
      return event.issue_number === undefined
        ? []
        : [
            refetch(["timeline", slug, event.issue_number]),
            refetch(["questions", slug, event.issue_number]),
            { key: ["issues", slug], scope: { contains: event.issue_number } },
          ];
    case "attachment":
      return event.issue_number === undefined
        ? []
        : [
            refetch(["issue", slug, event.issue_number]),
            refetch(["timeline", slug, event.issue_number]),
            refetch(["attachments", slug, event.issue_number]),
          ];
    case "spec":
      // A push moves the "current" file set and the denormalized issue
      // columns (version / review status) that feed list badges.
      return event.issue_number === undefined
        ? []
        : [
            refetch(["spec", slug, event.issue_number]),
            refetch(["spec-files", slug, event.issue_number, "current"]),
            refetch(["issue", slug, event.issue_number]),
            refetch(["issues", slug]),
          ];
    case "status":
      return [refetch(["statuses", slug]), refetch(["issues", slug])];
    case "label":
      return [refetch(["labels", slug]), refetch(["issues", slug])];
    case "member":
      return [refetch(["members", slug])];
    case "project":
      return [refetch(["project", slug]), refetch(["projects"])];
  }
}

/**
 * The inbox badge (T-97) is user-scoped and cross-project, so it stays out
 * of invalidationsFor's per-project map — but the stream we are already
 * subscribed to is the fastest signal available for the project in view. Its
 * own change signal is a 30s poll of /activity, which is what left the badge
 * trailing the list by up to half a minute (T-112). Activity in projects the
 * user is *not* looking at still waits for that poll.
 *
 * Only entities that can move a row in or out: comments and timeline entries
 * (unread counts, questions), spec pushes and reviews (pending review), and
 * issue updates — closing one retires both pending reasons (T-111). Events
 * carry no actor, so the user's own writes refetch too; the server answer is
 * authoritative either way, and one coalescing window collapses a burst.
 */
export function inboxInvalidations(event: ChangeEvent): Invalidation[] {
  switch (event.entity) {
    case "issue":
    case "comment":
    case "timeline":
    case "spec":
      return [refetch(["inbox"])];
    default:
      return [];
  }
}

/**
 * Shape test for `contains`: an issue-list-like page holding the row.
 * The counts cache shares the ["issues", slug] prefix but has no items,
 * so it falls through to false and is only marked stale.
 */
export function pageContainsIssue(data: unknown, issueNumber: number): boolean {
  if (typeof data !== "object" || data === null) return false;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return items.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { number?: unknown }).number === issueNumber,
  );
}

export function applyInvalidation(
  queryClient: QueryClient,
  invalidation: Invalidation,
): void {
  const { key, scope } = invalidation;
  if (scope === "refetch") {
    queryClient.invalidateQueries({ queryKey: key });
    return;
  }
  queryClient.invalidateQueries({ queryKey: key, refetchType: "none" });
  queryClient.invalidateQueries({
    queryKey: key,
    refetchType: "active",
    predicate: (query) => pageContainsIssue(query.state.data, scope.contains),
  });
}

/** Everything a reconnect might have missed. */
export function reconnectInvalidations(slug: string): QueryKeyLike[] {
  return [
    ["issues", slug],
    ["issue", slug],
    ["timeline", slug],
    ["questions", slug],
    ["attachments", slug],
    ["spec", slug],
    ["spec-files", slug],
    ["statuses", slug],
    ["labels", slug],
    ["members", slug],
    ["project", slug],
    // Not project-scoped, but a drop may have swallowed the events that
    // would have refreshed it (T-112).
    ["inbox"],
  ];
}

/**
 * The server heartbeats every 30s; three silent beats means the stream is
 * dead even if the browser still thinks it is open (a proxy can hold the
 * client side of a connection open long after the upstream died — vite's
 * dev proxy does exactly this).
 */
export const STALL_TIMEOUT_MS = 90_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Agents post runs of events in quick succession (a status change plus a
 * comment plus a reference, within a second); refetching per event would
 * fetch the same pages repeatedly. One trailing window batches them; a
 * broad "refetch" on a key subsumes any `contains` on the same key.
 */
export const INVALIDATE_COALESCE_MS = 300;

/**
 * Subscribes to the project SSE change feed for as long as the component
 * is mounted. Reconnects are driven from here rather than left to the
 * browser: EventSource only retries transport-level drops, and gives up
 * permanently when a retry gets a non-200 response — which is exactly what
 * a reverse proxy answers (502) while the server restarts. After any drop
 * we run a full compensation invalidate since events may have been missed.
 */
export function useProjectEvents(slug: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;
    let dropped = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: Invalidation[] = [];

    const flush = () => {
      flushTimer = undefined;
      const batch = pending;
      pending = [];
      const broad = new Set(
        batch
          .filter((inv) => inv.scope === "refetch")
          .map((inv) => JSON.stringify(inv.key)),
      );
      const seen = new Set<string>();
      for (const inv of batch) {
        const id = JSON.stringify([inv.key, inv.scope]);
        if (seen.has(id)) continue;
        seen.add(id);
        if (inv.scope !== "refetch" && broad.has(JSON.stringify(inv.key))) {
          continue;
        }
        applyInvalidation(queryClient, inv);
      }
    };

    const enqueue = (invalidations: Invalidation[]) => {
      pending.push(...invalidations);
      if (flushTimer === undefined) {
        flushTimer = setTimeout(flush, INVALIDATE_COALESCE_MS);
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) return;
      dropped = true;
      source?.close();
      source = null;
      const backoff = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** attempts,
      );
      attempts += 1;
      // Jitter spreads the herd of tabs reconnecting after one restart.
      reconnectTimer = setTimeout(connect, backoff * (0.5 + Math.random() / 2));
    };

    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(scheduleReconnect, STALL_TIMEOUT_MS);
    };

    const connect = () => {
      reconnectTimer = undefined;
      if (disposed) return;
      const es = new EventSource(api.eventsUrl(slug));
      source = es;
      armStallTimer();

      es.addEventListener(SSE_CHANGE_EVENT, (e: MessageEvent) => {
        armStallTimer();
        let event: ChangeEvent;
        try {
          event = ChangeEventSchema.parse(JSON.parse(e.data as string));
        } catch {
          return;
        }
        enqueue([
          ...invalidationsFor(event, slug),
          ...inboxInvalidations(event),
        ]);
      });
      es.addEventListener(SSE_PING_EVENT, armStallTimer);
      es.onopen = () => {
        attempts = 0;
        armStallTimer();
        if (dropped) {
          dropped = false;
          for (const queryKey of reconnectInvalidations(slug)) {
            queryClient.invalidateQueries({ queryKey });
          }
        }
      };
      es.onerror = () => {
        dropped = true;
        // CONNECTING means the browser is retrying on its own; CLOSED means
        // it has given up for good and the stream is ours to rebuild.
        if (es.readyState === EventSource.CLOSED) scheduleReconnect();
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(stallTimer);
      clearTimeout(flushTimer);
      pending = [];
      source?.close();
    };
  }, [slug, queryClient]);
}
