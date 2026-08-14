import { queryOptions } from "@tanstack/react-query";
import type { InboxItem } from "@todou/shared";
import { api } from "@/api/queries.ts";

export const inboxQuery = queryOptions({
  queryKey: ["inbox"],
  queryFn: () => api.getInbox(),
});

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

// The 30s /activity poll that used to signal this query (T-112) is gone:
// the shell's user-level SSE stream covers every readable project (T-122),
// and reconnect compensation invalidates ["inbox"] after a drop. Read
// positions stay private and eventless, so a mark-read on another machine
// never signals — react-query's focus refetch covers that gap.
