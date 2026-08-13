import type {
  IssueEventType,
  TimelineEvent,
  TimelineItem,
} from "@todou/shared";

/**
 * Merging (T-92) is a pure view over the raw timeline: the server keeps
 * emitting one event per action, and these helpers fold adjacent runs into
 * render units just before display. Anchors, fold counts, and follow-bottom
 * all stay keyed on the raw items.
 */

/**
 * Adjacent events further apart than this never merge (inclusive bound) —
 * except in families windowMsFor exempts.
 */
export const MERGE_WINDOW_MS = 300_000;

export type MergeFamily = "status" | "labels" | "referenced" | "attachments";

/**
 * References arrive whenever some other card's work touches this one —
 * hours apart by nature, so a gesture-sized window would never fold them
 * (T-99). GitHub batches "This was referenced" just as liberally.
 * Adjacency and the session key still gate the merge.
 */
export function windowMsFor(family: MergeFamily): number {
  return family === "referenced" ? Number.POSITIVE_INFINITY : MERGE_WINDOW_MS;
}

/**
 * Only low-information, high-frequency types merge. Milestones
 * (opened/closed/reopened), spec events (spec_pushed renders a version card
 * that a collapsed group would hide), and rare types stay standalone.
 * label_added and label_removed share a family on purpose: one triage
 * gesture often does both, and GitHub renders that as a single row.
 */
const FAMILY_BY_TYPE: Partial<Record<IssueEventType, MergeFamily>> = {
  status_changed: "status",
  label_added: "labels",
  label_removed: "labels",
  referenced: "referenced",
  attachment_added: "attachments",
};

export function familyOf(type: IssueEventType): MergeFamily | null {
  return FAMILY_BY_TYPE[type] ?? null;
}

/**
 * Merge granularity: actor + agent + model + session_id. The same machine
 * account is shared by many agent sessions, and the session badge (with its
 * copy-resume affordance) only stays meaningful if a group never spans two
 * sessions. `agent` participates so a context-less write (human web UI)
 * never merges with an agent write that omitted model/session.
 */
export function groupKey(event: TimelineEvent): string {
  const ctx = event.agent_context;
  return [
    event.actor.id,
    ctx?.agent ?? "",
    ctx?.model ?? "",
    ctx?.session_id ?? "",
  ].join("\u0000");
}

export type RenderUnit =
  | { kind: "item"; item: TimelineItem }
  | { kind: "group"; family: MergeFamily; events: TimelineEvent[] };

/**
 * Fold consecutive same-family, same-key events within the window into
 * groups; everything else passes through untouched. Single-event runs stay
 * plain items so today's rendering is the unchanged baseline — except
 * referenced, whose lone events still come out as groups so one reference
 * renders exactly like many (T-99). Order is never rearranged — any
 * comment or foreign-family item splits the run.
 */
export function groupTimeline(items: TimelineItem[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  let run: {
    family: MergeFamily;
    key: string;
    lastMs: number;
    events: TimelineEvent[];
  } | null = null;

  const flush = () => {
    if (!run) return;
    const first = run.events[0];
    if (run.events.length === 1 && first && run.family !== "referenced") {
      units.push({ kind: "item", item: first });
    } else {
      units.push({ kind: "group", family: run.family, events: run.events });
    }
    run = null;
  };

  for (const item of items) {
    const family = item.type === "event" ? familyOf(item.event_type) : null;
    if (item.type !== "event" || family === null) {
      flush();
      units.push({ kind: "item", item });
      continue;
    }
    const key = groupKey(item);
    const ms = Date.parse(item.created_at);
    if (
      run &&
      run.family === family &&
      run.key === key &&
      ms - run.lastMs <= windowMsFor(family)
    ) {
      run.events.push(item);
      run.lastMs = ms;
    } else {
      flush();
      run = { family, key, lastMs: ms, events: [item] };
    }
  }
  flush();
  return units;
}

/** Tolerant name extraction shared with describeEvent — bad payloads render "?". */
export const asName = (v: unknown): string =>
  typeof v === "object" && v !== null && "name" in v
    ? String((v as { name: unknown }).name)
    : "?";

const statusId = (v: unknown): unknown =>
  typeof v === "object" && v !== null && "id" in v
    ? (v as { id: unknown }).id
    : null;

export type StatusChain = {
  hops: { from: string; to: string }[];
  net: { from: string; to: string };
  /** The chain returns to its start — nothing net happened. */
  isNoop: boolean;
};

/**
 * A status run collapses to its net transition (T-92: "A→B, B→C reads as
 * A→C"). Noop detection compares status ids when both ends carry them —
 * names can be renamed mid-chain — and falls back to names for historical
 * payloads.
 */
export function netStatusChain(events: TimelineEvent[]): StatusChain {
  const hops = events.map((e) => ({
    from: asName(e.payload.from),
    to: asName(e.payload.to),
  }));
  const first = events[0];
  const last = events[events.length - 1];
  const net = {
    from: hops[0]?.from ?? "?",
    to: hops[hops.length - 1]?.to ?? "?",
  };
  const fromId = first ? statusId(first.payload.from) : null;
  const toId = last ? statusId(last.payload.to) : null;
  const isNoop =
    fromId !== null && toId !== null ? fromId === toId : net.from === net.to;
  return { hops, net, isNoop };
}
