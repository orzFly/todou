import type { TimelineEvent, TimelineItem } from "@todou/shared";
import {
  familyOfEvent,
  groupKey,
  MERGE_WINDOW_MS,
} from "@/components/timeline/group-events.ts";

/** What one host event took off the timeline, by the reason it went. */
export type Fold = { references: TimelineEvent[]; undone: TimelineEvent[] };

export type FoldResult = {
  /** Collapsed hosts' events removed; an expanded host's stay in place. */
  items: TimelineItem[];
  /** Host event id → what it absorbs, expanded or not: the toggle's label
      is counted off this either way. */
  folds: Map<number, Fold>;
  /** Absorbed event id → its host, for the anchor to find which to open. */
  hostOf: Map<number, number>;
};

type Indexed = { event: TimelineEvent; index: number; ms: number };

/** An added or removed edge whose role a header can spell. */
const isBlockEdgeEvent = (event: TimelineEvent) => {
  const family = familyOfEvent(event);
  return family === "block_added" || family === "block_removed";
};

/** Where in `list` (ascending by index) the entries past `index` start. */
function positionAfter(list: Indexed[], index: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Indexed).index > index) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The card a reference came from, as `projectId#number`, or null where the
 * payload cannot say for certain. A slug-only row is an old one, and its
 * slug may have changed hands since; folding it under the wrong block would
 * hide the one trace of a different card.
 */
function referenceSourceKey(
  event: TimelineEvent,
  projectId: number | undefined,
): string | null {
  const { by_issue, by_project_id, by_project } = event.payload;
  if (typeof by_issue !== "number") return null;
  if (typeof by_project_id === "number") return `${by_project_id}#${by_issue}`;
  if (typeof by_project === "string" || projectId === undefined) return null;
  return `${projectId}#${by_issue}`;
}

function blockOtherKey(event: TimelineEvent): string | null {
  const { other_project_id, other_number } = event.payload;
  return typeof other_project_id === "number" &&
    typeof other_number === "number"
    ? `${other_project_id}#${other_number}`
    : null;
}

/**
 * Take the events a block operation makes redundant off the timeline (T-598)
 * and say which block event each now hangs under.
 *
 * An edge added and dropped again inside one operation cancels out (R2),
 * but only into a host that stays visible: an operation that was nothing
 * but the round trip has nothing else to show, and must not vanish. The
 * reference a card wrote here moments before it was declared a block end
 * folds under that `block_added` (R1); the actor is compared and the
 * session is not, because an agent often files a card in one session and
 * blocks it from another.
 *
 * Everything is judged against the loaded items only, so a match still
 * behind the fold is simply not a match until it arrives.
 */
export function foldTimeline(
  items: TimelineItem[],
  opts: { projectId?: number; isExpanded?: (hostId: number) => boolean } = {},
): FoldResult {
  const events: Indexed[] = [];
  items.forEach((item, index) => {
    if (item.type === "event") {
      events.push({ event: item, index, ms: Date.parse(item.created_at) });
    }
  });

  // R2 candidates: an add followed by a remove of the same edge, same key.
  const openAdd = new Map<string, Indexed>();
  const pairs: [Indexed, Indexed][] = [];
  const paired = new Set<number>();
  for (const entry of events) {
    const { event } = entry;
    if (!isBlockEdgeEvent(event)) continue;
    const edge = event.payload.edge_id;
    if (typeof edge !== "number") continue;
    const key = `${groupKey(event)}\u0000${edge}`;
    if (event.event_type === "block_added") {
      openAdd.set(key, entry);
      continue;
    }
    const add = openAdd.get(key);
    openAdd.delete(key);
    if (add && entry.ms - add.ms <= MERGE_WINDOW_MS) {
      pairs.push([add, entry]);
      paired.add(add.event.id);
      paired.add(entry.event.id);
    }
  }

  // Hosts are block edge events outside every candidate pair, so a host is
  // never itself something another pair hides.
  const hostsByKey = new Map<string, Indexed[]>();
  for (const entry of events) {
    if (!isBlockEdgeEvent(entry.event) || paired.has(entry.event.id)) continue;
    const key = groupKey(entry.event);
    const list = hostsByKey.get(key);
    if (list) list.push(entry);
    else hostsByKey.set(key, [entry]);
  }

  const folds = new Map<number, Fold>();
  const hostOf = new Map<number, number>();
  const absorb = (
    host: TimelineEvent,
    kind: keyof Fold,
    ...absorbed: TimelineEvent[]
  ) => {
    let fold = folds.get(host.id);
    if (!fold) {
      fold = { references: [], undone: [] };
      folds.set(host.id, fold);
    }
    for (const event of absorbed) {
      fold[kind].push(event);
      hostOf.set(event.id, host.id);
    }
  };

  const cancelled = new Set<number>();
  for (const [add, remove] of pairs) {
    const hosts = hostsByKey.get(groupKey(add.event)) ?? [];
    const after = hosts[positionAfter(hosts, remove.index)];
    const before = hosts[positionAfter(hosts, add.index) - 1];
    const host =
      after && after.ms - remove.ms <= MERGE_WINDOW_MS
        ? after
        : before && add.ms - before.ms <= MERGE_WINDOW_MS
          ? before
          : undefined;
    if (!host) continue;
    absorb(host.event, "undone", add.event, remove.event);
    cancelled.add(add.event.id);
    cancelled.add(remove.event.id);
  }

  // R1: only additions that stayed. Once the edge is gone again the
  // reference is all that is left between the two cards.
  const addsByActorAndCard = new Map<string, Indexed[]>();
  for (const entry of events) {
    const { event } = entry;
    if (event.event_type !== "block_added" || !isBlockEdgeEvent(event)) {
      continue;
    }
    if (cancelled.has(event.id)) continue;
    const other = blockOtherKey(event);
    if (other === null) continue;
    const key = `${event.actor.id}\u0000${other}`;
    const list = addsByActorAndCard.get(key);
    if (list) list.push(entry);
    else addsByActorAndCard.set(key, [entry]);
  }
  for (const entry of events) {
    const { event } = entry;
    if (
      event.event_type !== "referenced" &&
      event.event_type !== "cross_referenced"
    ) {
      continue;
    }
    const source = referenceSourceKey(event, opts.projectId);
    if (source === null) continue;
    const candidates = addsByActorAndCard.get(
      `${event.actor.id}\u0000${source}`,
    );
    let host: Indexed | undefined;
    for (const candidate of candidates ?? []) {
      const distance = Math.abs(candidate.ms - entry.ms);
      if (
        distance <= MERGE_WINDOW_MS &&
        (host === undefined || distance < Math.abs(host.ms - entry.ms))
      ) {
        host = candidate;
      }
    }
    if (host) absorb(host.event, "references", event);
  }

  if (hostOf.size === 0) return { items, folds, hostOf };
  const expanded = opts.isExpanded ?? (() => false);
  const kept = items.filter((item) => {
    if (item.type !== "event") return true;
    const host = hostOf.get(item.id);
    return host === undefined || expanded(host);
  });
  return { items: kept, folds, hostOf };
}
