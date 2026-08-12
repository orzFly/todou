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
 * Pointer event → stale query keys. Exported pure for tests. Events carry
 * no data, so every mapping ends in a refetch through the authorized API.
 */
export function invalidationsFor(
  event: ChangeEvent,
  slug: string,
): QueryKeyLike[] {
  switch (event.entity) {
    case "issue":
      return event.issue_number === undefined
        ? [["issues", slug]]
        : [
            ["issues", slug],
            ["issue", slug, event.issue_number],
            ["timeline", slug, event.issue_number],
          ];
    case "comment":
    case "timeline":
      // Question components and their answers ride the timeline, so the
      // per-issue question status (#19) goes stale with it.
      return event.issue_number === undefined
        ? []
        : [
            ["timeline", slug, event.issue_number],
            ["questions", slug, event.issue_number],
          ];
    case "attachment":
      return event.issue_number === undefined
        ? []
        : [
            ["issue", slug, event.issue_number],
            ["timeline", slug, event.issue_number],
            ["attachments", slug, event.issue_number],
          ];
    case "spec":
      // A push moves the "current" file set and the denormalized issue
      // columns (version / review status) that feed list badges.
      return event.issue_number === undefined
        ? []
        : [
            ["spec", slug, event.issue_number],
            ["spec-files", slug, event.issue_number, "current"],
            ["issue", slug, event.issue_number],
            ["issues", slug],
          ];
    case "status":
      return [
        ["statuses", slug],
        ["issues", slug],
      ];
    case "label":
      return [
        ["labels", slug],
        ["issues", slug],
      ];
    case "member":
      return [["members", slug]];
    case "project":
      return [["project", slug], ["projects"]];
  }
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
        for (const queryKey of invalidationsFor(event, slug)) {
          queryClient.invalidateQueries({ queryKey });
        }
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
      source?.close();
    };
  }, [slug, queryClient]);
}
