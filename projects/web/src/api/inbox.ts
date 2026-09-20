import { queryOptions } from "@tanstack/react-query";
import type { InboxItem, InboxPage } from "@todou/shared";
import { api } from "@/api/queries.ts";
import { runtimeQueryOptions } from "@/api/runtime/query-adapter.ts";
import { resource } from "@/api/runtime/resources.ts";

export const inboxQuery = runtimeQueryOptions(
  queryOptions({
    queryKey: ["inbox"],
    queryFn: () => api.getInbox(),
  }),
  { kind: "direct", resources: [resource("inbox", "/me/inbox")] },
);

export type InboxGroup = { project: InboxItem["project"]; items: InboxItem[] };

/**
 * Fold the flat /me/inbox payload into per-project groups. Items arrive
 * sorted by last_activity_at desc, so the first sighting of a project is
 * its newest row: insertion order doubles as the group order, and rows
 * keep the server order within each group.
 */
export function groupInboxItems(items: InboxItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const item of items) {
    const group = groups.get(item.project.slug);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(item.project.slug, {
        project: item.project,
        items: [item],
      });
    }
  }
  return [...groups.values()];
}

/** Exact per-project row counts, even when the payload is trimmed. */
export function unreadCounts(
  page: InboxPage | undefined,
): Record<string, number> {
  return page?.unread_counts ?? {};
}

/** Cross-project total for the navbar; unavailable inbox data counts as zero. */
export function unreadTotal(page: InboxPage | undefined): number {
  return Object.values(unreadCounts(page)).reduce(
    (sum, count) => sum + count,
    0,
  );
}

// The 30s /activity poll that used to signal this query (T-112) is gone:
// the shell's user-level SSE stream covers every readable project (T-122),
// and reconnect compensation invalidates ["inbox"] after a drop. Read
// positions and preferences still write no change event, but each one now
// sends the account's own opt-in connections a `me` event (T-275), so a
// mark-read on another machine reaches this query without waiting for the
// focus refetch.
