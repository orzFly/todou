import { useQueryClient } from "@tanstack/react-query";
import {
  type ChangeEvent,
  ChangeEvent as ChangeEventSchema,
  SSE_CHANGE_EVENT,
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
 * Subscribes to the project SSE change feed for as long as the component
 * is mounted. EventSource reconnects on its own; after a drop we run a
 * full compensation invalidate since events may have been missed.
 */
export function useProjectEvents(slug: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource(api.eventsUrl(slug));
    let dropped = false;

    source.addEventListener(SSE_CHANGE_EVENT, (e: MessageEvent) => {
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
    source.onerror = () => {
      dropped = true;
    };
    source.onopen = () => {
      if (dropped) {
        dropped = false;
        for (const queryKey of reconnectInvalidations(slug)) {
          queryClient.invalidateQueries({ queryKey });
        }
      }
    };

    return () => source.close();
  }, [slug, queryClient]);
}
