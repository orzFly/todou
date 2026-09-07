import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ChangeEvent,
  type CrossChangeEvent,
  CrossChangeEvent as CrossChangeEventSchema,
  type InboxItem,
  type InboxRowState,
  type MeEvent,
  MeEvent as MeEventSchema,
  SSE_CHANGE_EVENT,
  SSE_ME_EVENT,
  SSE_PING_EVENT,
} from "@todou/shared";
import { useEffect } from "react";
import { api, clientOrigin } from "@/api/queries.ts";

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
 *
 * `inboxRows` compares the server's fingerprint of one inbox row against the
 * cached copy of that row (T-275); `stillUnread` narrows a list refetch to
 * the pages whose copy of a row still shows unread. Both carry a list rather
 * than a single row because `coalesceBatch` merges every one of them on a
 * key into one — see there for why.
 */
export type InboxRowVerdict = {
  project: string;
  number: number;
  row: InboxRowState | null;
};
export type InvalidationScope =
  | "refetch"
  | { contains: number }
  | { inboxRows: InboxRowVerdict[] }
  | { stillUnread: number[] };
export type Invalidation = { key: QueryKeyLike; scope: InvalidationScope };

const refetch = (key: QueryKeyLike): Invalidation => ({
  key,
  scope: "refetch",
});

/**
 * Pointer event → invalidation descriptors. Exported pure for tests.
 * Events carry no data, so every mapping ends in a refetch through the
 * authorized API. The stream is user-level (T-122), so `slug` is the
 * event's own project — invalidating a project the user is not looking at
 * just marks its inactive queries stale for their next mount.
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
      // A membership change can grant or revoke a whole project — the
      // user-level stream delivers your own member events even for projects
      // outside the visible set, so the switcher updates live (T-122).
      return [
        refetch(["members", slug]),
        refetch(["projects"]),
        refetch(["agent-memberships"]),
      ];
    case "project":
      return [refetch(["project", slug]), refetch(["projects"])];
  }
}

/**
 * The inbox badge (T-97) is user-scoped and cross-project. Since T-122 the
 * stream is too, so this covers every readable project — the 30s /activity
 * poll that bridged the not-in-view projects (T-112) is gone.
 *
 * Only entities that can move a row in or out: comments and timeline entries
 * (unread counts, questions), spec pushes and reviews (pending review), and
 * issue updates — closing one retires both pending reasons (T-111).
 *
 * Whether a given change concerns *this* reader is a question the payload
 * cannot answer — it is a pointer, with no actor and no state — so the
 * server answers it per receiver in `inbox_row` (T-275): the deciding
 * fields of the reader's own row for that issue. Comparing them against the
 * cached row leaves two branches, where the T-273 boolean needed three, and
 * makes a replayed event free: identical fields mean nothing to do.
 */
export function inboxInvalidations(event: CrossChangeEvent): Invalidation[] {
  switch (event.entity) {
    case "issue":
    case "comment":
    case "timeline":
    case "spec":
      break;
    default:
      return [];
  }
  // Absent means the server did not work it out — an older server, a
  // subscription that did not ask, a failed judgement, a flood — and the
  // only safe reading of "I don't know" is the pre-T-273 one.
  if (event.inbox_row === undefined || event.issue_number === undefined) {
    return [refetch(["inbox"])];
  }
  return [
    {
      key: ["inbox"],
      scope: {
        inboxRows: [
          {
            project: event.project,
            number: event.issue_number,
            row: event.inbox_row,
          },
        ],
      },
    },
  ];
}

/**
 * Pointer-free event about the reader's own account → invalidation
 * descriptors (T-275). Exported pure for tests.
 *
 * `["issues", …]` is in here because the unread markers travel in the list
 * payload (T-46), so a read position moves them as surely as it moves the
 * inbox.
 */
export function meInvalidations(event: MeEvent): Invalidation[] {
  switch (event.kind) {
    case "issue_read":
      return [
        {
          key: ["inbox"],
          scope: {
            inboxRows: [
              {
                project: event.project,
                number: event.issue_number,
                row: event.inbox_row,
              },
            ],
          },
        },
        // A mark-read always ends in "unread: false, unread_comments: 0" for
        // that row, so the event needs to carry neither: only the pages
        // still showing it lit have anything to refetch.
        {
          key: ["issues", event.project],
          scope: { stillUnread: [event.issue_number] },
        },
      ];
    case "reads_swept":
      return event.projects === undefined
        ? [refetch(["inbox"]), refetch(["issues"])]
        : [
            refetch(["inbox"]),
            ...event.projects.map((slug) => refetch(["issues", slug])),
          ];
    case "prefs":
      // show_weak_unread decides which rows /me/inbox returns at all.
      return [refetch(["inbox"]), refetch(["me-prefs"])];
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

/**
 * The cached inbox row for one issue, or undefined when this cache entry
 * does not hold it. Anything that is not a list of rows — the badge count,
 * an error state — reads as "does not hold it", so it is left alone.
 */
export function inboxRowIn(
  data: unknown,
  project: string,
  issueNumber: number,
): InboxItem | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  return items.find((item) => {
    if (typeof item !== "object" || item === null) return false;
    if ((item as { number?: unknown }).number !== issueNumber) return false;
    const itemProject = (item as { project?: unknown }).project;
    if (typeof itemProject !== "object" || itemProject === null) return false;
    return (itemProject as { slug?: unknown }).slug === project;
  }) as InboxItem | undefined;
}

/**
 * Does this cache entry disagree with the server about what the reader has
 * to attend to? True whenever the row arrives, leaves, or keeps any of the
 * unread / pending-review / open-question fields at a different value —
 * which is exactly the set the badge count and the row's markers are drawn
 * from, so a true here means a refetch.
 */
export function inboxAttentionDiffers(
  data: unknown,
  project: string,
  issueNumber: number,
  row: InboxRowState | null,
): boolean {
  const cached = inboxRowIn(data, project, issueNumber);
  if (row === null) return cached !== undefined;
  if (cached === undefined) return true;
  return (
    cached.unread !== row.unread ||
    cached.unread_comments !== row.unread_comments ||
    cached.pending_spec_review !== row.pending_spec_review ||
    cached.open_questions !== row.open_questions
  );
}

/**
 * Does this cache entry hold the row with the right attention fields but an
 * older `updated_at`? That means the title, status, labels or assignees may
 * have moved while the badge did not, which is worth marking stale and not
 * worth a request.
 */
export function inboxRowContentDiffers(
  data: unknown,
  project: string,
  issueNumber: number,
  row: InboxRowState | null,
): boolean {
  if (row === null) return false;
  if (inboxAttentionDiffers(data, project, issueNumber, row)) return false;
  const cached = inboxRowIn(data, project, issueNumber);
  if (cached === undefined) return false;
  return cached.updated_at !== row.updated_at;
}

/**
 * Shape test for `stillUnread`: an issue-list-like page whose copy of the
 * row still shows unread. The counts cache shares the ["issues", slug]
 * prefix but has no items, so it reads false.
 */
export function pageHasUnreadRow(data: unknown, issueNumber: number): boolean {
  if (typeof data !== "object" || data === null) return false;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    if ((item as { number?: unknown }).number !== issueNumber) return false;
    const row = item as { unread?: unknown; unread_comments?: unknown };
    return (
      row.unread === true ||
      (typeof row.unread_comments === "number" && row.unread_comments > 0)
    );
  });
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
  if ("inboxRows" in scope) {
    const verdicts = scope.inboxRows;
    const attention = (data: unknown) =>
      verdicts.some((v) =>
        inboxAttentionDiffers(data, v.project, v.number, v.row),
      );
    // Two passes, like `contains` below, but both of them carry a
    // predicate. There the first pass is a broad stale-marking one because
    // the row may have moved and every page is suspect. Here the server has
    // described the rows themselves, so the first pass marks only the caches
    // that hold them with the same attention fields and older content, and
    // caches that agree on everything are left as they are — which is what
    // makes a replayed event cost nothing.
    queryClient.invalidateQueries({
      queryKey: key,
      refetchType: "none",
      predicate: (query) =>
        !attention(query.state.data) &&
        verdicts.some((v) =>
          inboxRowContentDiffers(query.state.data, v.project, v.number, v.row),
        ),
    });
    queryClient.invalidateQueries({
      queryKey: key,
      refetchType: "active",
      predicate: (query) => attention(query.state.data),
    });
    return;
  }
  if ("stillUnread" in scope) {
    // No stale-marking pass: the server has already established that these
    // rows' unread state is cleared, so a page that agrees has nothing to
    // reconsider.
    queryClient.invalidateQueries({
      queryKey: key,
      refetchType: "active",
      predicate: (query) =>
        scope.stillUnread.some((number) =>
          pageHasUnreadRow(query.state.data, number),
        ),
    });
    return;
  }
  queryClient.invalidateQueries({ queryKey: key, refetchType: "none" });
  queryClient.invalidateQueries({
    queryKey: key,
    refetchType: "active",
    predicate: (query) => pageContainsIssue(query.state.data, scope.contains),
  });
}

/**
 * One coalescing window's invalidations, reduced to what is worth applying.
 * Exported pure for tests.
 *
 * Three rules, in order:
 *
 * 1. A broad refetch on a key subsumes every narrower scope on it.
 * 2. Identical descriptors collapse into one.
 * 3. The list-carrying scopes on one key merge into a single descriptor.
 *
 * Rule 3 is what keeps a flood cheap. `invalidateQueries` defaults to
 * `cancelRefetch: true` — for good reason, since an in-flight response may
 * predate the event — so N descriptors that each match the same cache entry
 * abort and restart the same request N times. Merging asks the question once
 * with every verdict in hand: refetch if any of them moved the reader's
 * attention, and the one response that arrives is authoritative for all of
 * them. Measured on a 50-event burst in another project: 14 inbox requests
 * before merging, 1 after.
 *
 * `contains` is deliberately not merged: it predates this and its own
 * safety argument (see InvalidationScope) rests on the broad refetch that
 * T-101 pairs with it, which rule 1 already applies.
 */
export function coalesceBatch(batch: Invalidation[]): Invalidation[] {
  const idOf = (key: QueryKeyLike) => JSON.stringify(key);
  const broad = new Set(
    batch.filter((inv) => inv.scope === "refetch").map((inv) => idOf(inv.key)),
  );

  const out: Invalidation[] = [];
  const seen = new Set<string>();
  const merged = new Map<string, Invalidation>();
  for (const inv of batch) {
    if (inv.scope !== "refetch" && broad.has(idOf(inv.key))) continue;
    const id = JSON.stringify([inv.key, inv.scope]);
    if (seen.has(id)) continue;
    seen.add(id);

    const scope = inv.scope;
    if (scope === "refetch" || "contains" in scope) {
      out.push(inv);
      continue;
    }
    const kind = "inboxRows" in scope ? "inboxRows" : "stillUnread";
    const mergeId = `${kind}:${idOf(inv.key)}`;
    const into = merged.get(mergeId);
    if (into === undefined) {
      // Copied, so merging never mutates a descriptor the caller still holds.
      merged.set(mergeId, {
        key: inv.key,
        scope:
          "inboxRows" in scope
            ? { inboxRows: [...scope.inboxRows] }
            : { stillUnread: [...scope.stillUnread] },
      });
      out.push(merged.get(mergeId) as Invalidation);
      continue;
    }
    const target = into.scope;
    if (
      "inboxRows" in scope &&
      typeof target === "object" &&
      "inboxRows" in target
    ) {
      target.inboxRows.push(...scope.inboxRows);
    } else if (
      "stillUnread" in scope &&
      typeof target === "object" &&
      "stillUnread" in target
    ) {
      target.stillUnread.push(...scope.stillUnread);
    }
  }
  return out;
}

/**
 * Everything a reconnect might have missed. Slug-less prefixes on purpose:
 * the stream carries every readable project, so the gap does too.
 */
export function reconnectInvalidations(): QueryKeyLike[] {
  return [
    ["issues"],
    ["issue"],
    ["timeline"],
    ["questions"],
    ["attachments"],
    ["spec"],
    ["spec-files"],
    ["statuses"],
    ["labels"],
    ["members"],
    ["agent-memberships"],
    ["project"],
    ["projects"],
    ["inbox"],
    // A preference toggled on another device during the outage arrives
    // nowhere else: its `me` event was dropped with the connection.
    ["me-prefs"],
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
 * Subscribes to the user-level SSE change feed for as long as the component
 * is mounted — one connection covers every readable project (T-122), so it
 * lives in the authed shell rather than a project layout. Reconnects are
 * driven from here rather than left to the browser: EventSource only retries
 * transport-level drops, and gives up permanently when a retry gets a
 * non-200 response — which is exactly what a reverse proxy answers (502)
 * while the server restarts. After any drop we run a full compensation
 * invalidate since events may have been missed.
 *
 * `enabled` exists for the shell's first paint: the header now renders before
 * `/api/me` answers (T-265), and until it does there is no telling whether a
 * session exists to stream — opening one regardless earns a visitor without
 * one a run of 401s and reconnects on the way to /login.
 */
export function useUserEvents(enabled = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
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
      for (const inv of coalesceBatch(batch)) {
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
      const es = new EventSource(api.userEventsUrl({ inbox: true }));
      source = es;
      armStallTimer();

      es.addEventListener(SSE_CHANGE_EVENT, (e: MessageEvent) => {
        armStallTimer();
        let event: CrossChangeEvent;
        try {
          event = CrossChangeEventSchema.parse(JSON.parse(e.data as string));
        } catch {
          return;
        }
        enqueue([
          ...invalidationsFor(event, event.project),
          ...inboxInvalidations(event),
        ]);
      });
      es.addEventListener(SSE_ME_EVENT, (e: MessageEvent) => {
        armStallTimer();
        let event: MeEvent;
        try {
          event = MeEventSchema.parse(JSON.parse(e.data as string));
        } catch {
          return;
        }
        // Our own write, echoed back. The mutation's onSettled already
        // invalidated locally, and MarkReadOnView re-sends its PUT about
        // every two seconds while a busy issue is open — responding to the
        // echo as well would repeat that work on the same cadence.
        if (event.origin === clientOrigin) return;
        enqueue(meInvalidations(event));
      });
      es.addEventListener(SSE_PING_EVENT, armStallTimer);
      es.onopen = () => {
        attempts = 0;
        armStallTimer();
        if (dropped) {
          dropped = false;
          for (const queryKey of reconnectInvalidations()) {
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
  }, [queryClient, enabled]);
}
