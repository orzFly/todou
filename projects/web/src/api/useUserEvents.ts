import type { QueryClient } from "@tanstack/react-query";
import { focusManager, useQueryClient } from "@tanstack/react-query";
import {
  type CrossChangeEvent,
  CrossChangeEvent as CrossChangeEventSchema,
  type MeEvent,
  MeEvent as MeEventSchema,
  SSE_CHANGE_EVENT,
  SSE_ME_EVENT,
  SSE_PING_EVENT,
} from "@todou/shared";
import { useEffect, useSyncExternalStore } from "react";
import {
  cachedIssueRow,
  coalesceBatch,
  entryWantsRefetch,
  INVALIDATE_COALESCE_MS,
  type Invalidation,
  inboxAttentionDiffers,
  inboxInvalidations,
  inboxRowContentDiffers,
  invalidationsFor,
  isSharedKey,
  meInvalidations,
  metadataEntryDiffers,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectInvalidations,
  STALL_TIMEOUT_MS,
  shouldAdopt,
  statusCategories,
} from "@/api/event-rules.ts";
import { issueListDescriptorOf } from "@/api/issues-cache.ts";
import { api, clientOrigin, runtime } from "@/api/queries.ts";
import { getRuntimeQueryAdapter } from "@/api/runtime/query-adapter.ts";
import { invalidateSearchRefQueries } from "@/api/search-refs.ts";
import {
  electLeader,
  openTabChannel,
  type TabChannel,
  type TabMessage,
  tabSyncSupported,
} from "@/api/tab-sync.ts";

// Keep the original import path compatible for callers and behavioral tests.
export * from "@/api/event-rules.ts";

/**
 * `maxRefetch` is the strongest refetch this tab is willing to pay for
 * (T-276): `"none"` on a tab the reader cannot see, which marks the same
 * queries stale and leaves the request to react-query's focus refetch.
 * Only the strength is lowered, never a predicate skipped — a hidden tab
 * told "this card is not in your inbox and not in your cache" still does
 * nothing at all, which is the half T-273 won.
 */
export function applyInvalidation(
  queryClient: QueryClient,
  invalidation: Invalidation,
  maxRefetch: "active" | "none" = "active",
): void {
  const { key, scope } = invalidation;
  if (scope === "refetch") {
    if (
      key[0] === "search-issue-ref" ||
      key[0] === "search-comment-ref" ||
      key[0] === "search-comment-location"
    ) {
      void invalidateSearchRefQueries(
        queryClient,
        {},
        {
          queryKey: key,
          refetchType: maxRefetch,
        },
      );
      return;
    }
    // Visible, the call has to keep its exact former shape: `refetchType`
    // defaults to "active", so spelling it out is equivalent at runtime but
    // would break the 15 existing `toHaveBeenCalledWith({ queryKey })`
    // assertions. Left alone, the whole existing suite is the proof that
    // nothing changed for a visible tab.
    const gate = maxRefetch === "none" ? { refetchType: "none" as const } : {};
    queryClient.invalidateQueries({ queryKey: key, ...gate });
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
      refetchType: maxRefetch,
      predicate: (query) => attention(query.state.data),
    });
    return;
  }
  if ("metadataRows" in scope) {
    const changes = scope.metadataRows;
    queryClient.invalidateQueries({
      queryKey: key,
      refetchType: maxRefetch,
      predicate: (query) =>
        changes.some((change) =>
          metadataEntryDiffers(query.state.data, change),
        ),
    });
    return;
  }
  // One pass, and no broad stale-marking one beside it. The pass that used
  // to precede `contains` marked every page under the key stale on the
  // grounds that a row may have moved — but a `contains` verdict comes from
  // an event that cannot move one, and on a nine-column board that pass cost
  // nine refetches the moment the reader came back to the tab (T-279).
  const verdicts = scope.issueRows;
  const slug = typeof key[1] === "string" ? key[1] : "";
  const context = {
    cached: (issueNumber: number) =>
      cachedIssueRow(queryClient, key, issueNumber),
    categoryOf: statusCategories(queryClient, slug),
  };
  queryClient.invalidateQueries({
    queryKey: key,
    refetchType: maxRefetch,
    predicate: (query) => {
      const descriptor = issueListDescriptorOf(query.meta);
      return verdicts.some((verdict) =>
        entryWantsRefetch(verdict, descriptor, query.state.data, context),
      );
    },
  });
}

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
 * Since T-276 only one tab of an account connects: the others take the same
 * frames over a `BroadcastChannel` and run them through the same handlers.
 * The lock and the channel are named after the user id, so a tab that signed
 * in as somebody else neither inherits the previous identity's stream nor
 * talks to a sibling still holding that identity's cache.
 *
 * `userId` is absent for the shell's first paint: the header now renders
 * before `/api/me` answers (T-265), and until it does there is no telling
 * whether a session exists to stream — opening one regardless earns a visitor
 * without one a run of 401s and reconnects on the way to /login.
 */
export function useUserEvents(userId?: number) {
  const queryClient = useQueryClient();
  const mode = useSyncExternalStore(
    (notify) => runtime.onMode(notify),
    () => runtime.mode,
    () => "fallback" as const,
  );

  useEffect(() => {
    if (userId === undefined || mode !== "worker") return;
    let lastSequence = 0;
    let pending: Invalidation[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = runtime.onFrame((frame) => {
      if (frame.runtimeEventSeq <= lastSequence) return;
      lastSequence = frame.runtimeEventSeq;
      // Worker already dirtied shared truth. Only page-owned complex queries
      // consume the frame here, preserving their existing row predicates.
      if (frame.eventType === "me" && frame.origin === clientOrigin) return;
      pending.push(...(frame.invalidations as Invalidation[]));
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        const batch = coalesceBatch(pending);
        pending = [];
        const apply = () => {
          for (const invalidation of batch) {
            applyInvalidation(
              queryClient,
              invalidation,
              document.visibilityState === "hidden" ? "none" : "active",
            );
          }
        };
        const adapter = getRuntimeQueryAdapter(queryClient);
        if (adapter) adapter.pageInvalidation(apply);
        else apply();
      }, INVALIDATE_COALESCE_MS);
    });
    return () => {
      release();
      clearTimeout(timer);
    };
  }, [mode, queryClient, userId]);

  useEffect(() => {
    if (userId === undefined || mode !== "fallback") return;
    let source: EventSource | null = null;
    let disposed = false;
    let dropped = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: Invalidation[] = [];
    let channel: TabChannel | undefined;
    let giveUpRole: (() => void) | undefined;
    let cleanupLifecycle: (() => void) | undefined;
    let parked = false;
    /** When this tab last learned a shared key was stale, by key hash. */
    const staleAt = new Map<string, number>();

    /**
     * `focusManager.isFocused()` rather than `document.visibilityState`,
     * because that is the very predicate deciding whether the focus refetch
     * this downgrade relies on will happen. One predicate for the downgrade
     * and for its safety net cannot disagree with itself; two separate reads
     * leave a query marked stale on a tab react-query does not consider to
     * have been refocused.
     */
    const gate = () => (focusManager.isFocused() ? "active" : "none");

    /**
     * Every path that marks a query stale on behalf of the feed, so the two
     * bookkeeping steps cannot come apart. The timestamp is what stops a
     * sibling's older response from being adopted over what we now know —
     * and a gap is exactly the moment when responses in flight predate it.
     * Recording it more eagerly than strictly needed only makes this tab
     * refuse a sibling and fall back to a focus refetch, the safe side.
     */
    const invalidate = (inv: Invalidation, maxRefetch: "active" | "none") => {
      if (isSharedKey(inv.key)) {
        staleAt.set(JSON.stringify(inv.key), Date.now());
      }
      applyInvalidation(queryClient, inv, maxRefetch);
    };

    const flush = () => {
      flushTimer = undefined;
      const batch = pending;
      pending = [];
      // Read once per flush rather than per frame: a burst is collected over
      // 300ms, and what counts is whether the reader can see the tab when it
      // lands. Coalescing first also means one window records at most one
      // timestamp per key.
      const maxRefetch = gate();
      for (const inv of coalesceBatch(batch)) {
        invalidate(inv, maxRefetch);
      }
    };

    const enqueue = (invalidations: Invalidation[]) => {
      pending.push(...invalidations);
      if (flushTimer === undefined) {
        flushTimer = setTimeout(flush, INVALIDATE_COALESCE_MS);
      }
    };

    /**
     * One SSE frame's worth of work, reached identically from this tab's own
     * connection and from a sibling's forwarded copy. Sharing the function
     * rather than the intent is what makes the order in the listeners below
     * structural: there is no second place where a frame could be handled
     * differently.
     */
    const onChangeFrame = (data: string) => {
      let event: CrossChangeEvent;
      try {
        event = CrossChangeEventSchema.parse(JSON.parse(data));
      } catch {
        return;
      }
      enqueue([
        ...invalidationsFor(event, event.project),
        ...inboxInvalidations(event),
      ]);
    };

    const onMeFrame = (data: string) => {
      let event: MeEvent;
      try {
        event = MeEventSchema.parse(JSON.parse(data));
      } catch {
        return;
      }
      // Our own write, echoed back. The mutation's onSettled already
      // invalidated locally, and MarkReadOnView re-sends its PUT about
      // every two seconds while a busy issue is open — responding to the
      // echo as well would repeat that work on the same cadence.
      if (event.origin === clientOrigin) return;
      enqueue(meInvalidations(event));
    };

    /**
     * Everything the stream may have missed while it was down. Runs through
     * `applyInvalidation` rather than invalidating directly so that a drop
     * cannot walk around the visibility gate.
     */
    const compensate = () => {
      const maxRefetch = gate();
      for (const key of reconnectInvalidations()) {
        invalidate({ key, scope: "refetch" }, maxRefetch);
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
      // Every namespace, because one account holds one stream (T-276) and
      // the leader cannot know which card its sibling tabs are looking at.
      // Not a contradiction of "default off": that is the protocol's
      // default, and this is the explicit opt-in that matches a page which
      // shows all of it.
      const es = new EventSource(
        api.userEventsUrl({ inbox: true, metadata: "*" }),
      );
      source = es;
      armStallTimer();

      // Forwarded before it is parsed, and the order is not interchangeable:
      // the `origin === clientOrigin` test inside `onMeFrame` speaks for
      // *this* tab only. Filtering first would mean the leader's own
      // mark-read never reaches any sibling — reopening precisely the hole
      // T-275 spent a section closing. Broadcast first, filter on each
      // receiving side, and both directions hold at once.
      es.addEventListener(SSE_CHANGE_EVENT, (e: MessageEvent) => {
        armStallTimer();
        channel?.post({ v: 1, frame: "change", data: e.data as string });
        onChangeFrame(e.data as string);
      });
      es.addEventListener(SSE_ME_EVENT, (e: MessageEvent) => {
        armStallTimer();
        channel?.post({ v: 1, frame: "me", data: e.data as string });
        onMeFrame(e.data as string);
      });
      es.addEventListener(SSE_PING_EVENT, armStallTimer);
      es.onopen = () => {
        attempts = 0;
        armStallTimer();
        if (dropped) {
          dropped = false;
          compensate();
          // Every tab missed the outage, not just this one, and an SSE frame
          // carries no id so nobody can say which events were lost. Giving
          // the stream event ids and a bounded replay would turn this into a
          // gap with a position; that is its own card, opened with T-275.
          channel?.post({ v: 1, frame: "gap" });
        }
      };
      es.onerror = () => {
        dropped = true;
        // CONNECTING means the browser is retrying on its own; CLOSED means
        // it has given up for good and the stream is ours to rebuild.
        if (es.readyState === EventSource.CLOSED) scheduleReconnect();
      };
    };

    /** Stops streaming without giving up anything else this tab is doing. */
    const stopStreaming = () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      clearTimeout(stallTimer);
      stallTimer = undefined;
      source?.close();
      source = null;
    };

    /**
     * A response this tab just fetched, offered to its siblings.
     *
     * `manual !== true` is the whole guard against an echo: `setQueryData`
     * reaches the reducer as a success action carrying `manual: true`, a real
     * fetch does not. Without it, adopting a response would look like getting
     * one and the two tabs would broadcast at each other indefinitely.
     */
    const offerResponse = () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        if (event.action.type !== "success" || event.action.manual === true) {
          return;
        }
        if (!isSharedKey(event.query.queryKey)) return;
        channel?.post({
          v: 1,
          frame: "data",
          key: [...event.query.queryKey],
          data: event.query.state.data,
          at: event.query.state.dataUpdatedAt,
        });
      });

    const adopt = (msg: Extract<TabMessage, { frame: "data" }>) => {
      if (!isSharedKey(msg.key)) return;
      const hash = JSON.stringify(msg.key);
      if (!shouldAdopt(msg.at, staleAt.get(hash))) return;
      staleAt.delete(hash);
      // Carrying the source's timestamp is what makes `staleTime` count the
      // data's real age rather than the moment it arrived here; the success
      // reducer clears `isInvalidated` with it, so an adopted key needs no
      // focus refetch either.
      queryClient.setQueryData(msg.key, msg.data, { updatedAt: msg.at });
    };

    const takeRole = () =>
      electLeader(`todou:events:${userId}`, ({ promoted }) => {
        // Promotion means the previous leader died and this cache is warm but
        // has a hole in it, which is exactly what `dropped` already describes
        // — so the first `onopen` runs the existing compensate-and-announce
        // path instead of a second one built beside it.
        if (promoted) dropped = true;
        connect();
        return stopStreaming;
      });

    let unsubscribeCache: (() => void) | undefined;
    if (!tabSyncSupported()) {
      connect();
    } else {
      channel = openTabChannel(`todou:events:${userId}:ch`, (msg) => {
        if (msg.frame === "change") onChangeFrame(msg.data);
        else if (msg.frame === "me") onMeFrame(msg.data);
        else if (msg.frame === "gap") compensate();
        else adopt(msg);
      });
      unsubscribeCache = offerResponse();
      giveUpRole = takeRole();

      // A frozen leader keeps the lock without delivering anything, and a
      // page in the back/forward cache would hold every sibling hostage for
      // as long as it stays there. The browser announces both, so hand the
      // role over on the announcement — no heartbeat, no threshold, and
      // correct whether or not this browser freezes a lock-holding page.
      // A tab waiting in the queue is by definition not the frozen one.
      const park = () => {
        if (parked || disposed) return;
        parked = true;
        giveUpRole?.();
        giveUpRole = undefined;
      };
      const unpark = () => {
        if (!parked || disposed) return;
        parked = false;
        giveUpRole = takeRole();
      };
      const onPageHide = (e: PageTransitionEvent) => {
        if (e.persisted) park();
      };
      const onPageShow = (e: PageTransitionEvent) => {
        if (e.persisted) unpark();
      };
      document.addEventListener("freeze", park);
      document.addEventListener("resume", unpark);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
      cleanupLifecycle = () => {
        document.removeEventListener("freeze", park);
        document.removeEventListener("resume", unpark);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("pageshow", onPageShow);
      };
    }

    return () => {
      disposed = true;
      cleanupLifecycle?.();
      unsubscribeCache?.();
      giveUpRole?.();
      channel?.close();
      clearTimeout(flushTimer);
      pending = [];
      stopStreaming();
    };
  }, [mode, queryClient, userId]);
}
