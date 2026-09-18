import type {
  IssueEventType,
  TimelineComment,
  TimelineEvent,
  TimelineItem,
} from "@todou/shared";
import { isHidden } from "@todou/shared";

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

export type MergeFamily =
  | "status"
  | "labels"
  | "referenced"
  | "attachments"
  | "assignees"
  | "spec_resolved";

/** The families whose runs render as always-visible rows under a header. */
export type ListFamily = "referenced" | "attachments" | "spec_resolved";
/** The rest: a summary row with an expander behind it. */
export type CollapsedFamily = Exclude<MergeFamily, ListFamily>;

/**
 * Both `groupTimeline` — which has to emit even a lone event of these
 * families as a group — and `EventGroup`, which has to render every group of
 * theirs as a list, ask this one question. Two copies of the answer would
 * eventually disagree, and the disagreement renders as either an empty
 * group shell or a row with no header over it.
 */
export function rendersAsList(family: MergeFamily): family is ListFamily {
  return (
    family === "referenced" ||
    family === "attachments" ||
    family === "spec_resolved"
  );
}

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
 * Low information and high frequency are asked of a run, not of a type: a
 * collapsed family's lone event passes straight through groupTimeline, so
 * one `assigned` on its own still renders as the hand-off it is, and what
 * the standard judges is a burst of them.
 * Milestones (opened/closed/reopened) and rare types stay standalone, and so
 * does any type whose row is not the whole of what it renders: spec_pushed
 * hangs a version card below its row, and a group that folds the row takes
 * the card with it.
 * label_added and label_removed share a family on purpose: one triage
 * gesture often does both, and GitHub renders that as a single row. assigned
 * and unassigned are the second such pair, with a stronger claim than
 * labels: handing a card to someone else emits both halves every time.
 * referenced and cross_referenced likewise: the reader cares who pointed
 * here, not whether they did it from this project, and every row says so
 * itself.
 */
const FAMILY_BY_TYPE: Partial<Record<IssueEventType, MergeFamily>> = {
  status_changed: "status",
  label_added: "labels",
  label_removed: "labels",
  referenced: "referenced",
  cross_referenced: "referenced",
  attachment_added: "attachments",
  assigned: "assignees",
  unassigned: "assignees",
  spec_comments_resolved: "spec_resolved",
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
  | { kind: "group"; family: MergeFamily; events: TimelineEvent[] }
  | { kind: "hidden"; comments: TimelineComment[] };

/**
 * The key a revealed run is remembered under: its first comment's id. Stable
 * across re-renders and re-fetches, and stable across a reveal — the run it
 * names keeps its first comment whatever else changes.
 */
export function hiddenRunKey(unit: { comments: TimelineComment[] }): string {
  return `hidden-${unit.comments[0]?.id ?? 0}`;
}

/**
 * Fold consecutive same-family, same-key events within the window into
 * groups; everything else passes through untouched. Single-event runs stay
 * plain items so today's rendering is the unchanged baseline — except the
 * list families, whose lone events still come out as groups so one reference
 * or one file renders exactly like many (T-99, T-369). Order is never
 * rearranged — any comment or foreign-family item splits the run.
 *
 * Adjacent hidden comments fold the same way (T-281), under the same rule:
 * an event between two of them ends the run, so hiding the comments around
 * a status change never takes the status change off the page.
 *
 * `isRevealed` answers for the runs the reader has already opened, keyed by
 * `hiddenRunKey`; those comments pass through as ordinary items. A predicate
 * rather than a set, so "reveal all" is one flag on the caller's side and
 * not a set that has to be kept in step with the runs that exist.
 *
 * What it scans has to be contiguous: a run is only a run if nothing the
 * reader cannot see sits inside it. The folded timeline arrives in two
 * pieces, and joining them is `groupTimelineSides`' job, not this one's.
 */
export function groupTimeline(
  items: TimelineItem[],
  isRevealed?: (key: string) => boolean,
): RenderUnit[] {
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
    if (run.events.length === 1 && first && !rendersAsList(run.family)) {
      units.push({ kind: "item", item: first });
    } else {
      units.push({ kind: "group", family: run.family, events: run.events });
    }
    run = null;
  };

  /** Extend the open hidden run or start one; false if this is not one. */
  const asHidden = (item: TimelineItem): boolean => {
    if (item.type !== "comment" || !isHidden(item)) return false;
    const open = units.at(-1);
    if (open?.kind === "hidden") open.comments.push(item);
    else units.push({ kind: "hidden", comments: [item] });
    return true;
  };

  for (const item of items) {
    const family = item.type === "event" ? familyOf(item.event_type) : null;
    if (item.type !== "event" || family === null) {
      flush();
      if (asHidden(item)) continue;
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
  // Expanded afterwards rather than inside the loop: a revealed run whose
  // comments went straight through as items would leave the next hidden
  // comment starting a second run under a different key, and that key is
  // the one the reveal is remembered by.
  if (isRevealed === undefined) return units;
  return units.flatMap((unit): RenderUnit[] =>
    unit.kind === "hidden" && isRevealed(hiddenRunKey(unit))
      ? unit.comments.map((item) => ({ kind: "item", item }))
      : [unit],
  );
}

/** Items a unit stands for — every kind carries its own, so the sizes of a
    scan's units sum to the number of items that went into it. */
const unitSize = (unit: RenderUnit): number =>
  unit.kind === "group"
    ? unit.events.length
    : unit.kind === "hidden"
      ? unit.comments.length
      : 1;

/**
 * Group both rendered sides of a folded timeline (T-30) — as one scan when
 * the seam between them is closed.
 *
 * A fold block in the seam means unloaded items really do sit between the
 * sides, so a run that spans it is two runs as far as anyone can tell, and
 * each side is scanned on its own. With no fold block the sides print back
 * to back with nothing between them, and scanning them separately was what
 * split one upload into `attached 2 files` and `attached 4 files` (T-404).
 * The seam closes whenever `remaining` reaches 0: on a 51-to-100-item card
 * the two 50-item windows meet from the start, and on a longer one they meet
 * once the reader has expanded the fold to the end.
 *
 * Where to cut the single scan back into two arrays is recovered by
 * counting: `above` is a prefix of the timeline and `below` the suffix after
 * it (`mergeFolded` drops the overlap), so the units cover the items in
 * order and the first `above.length` of them belong to the head side. A unit
 * straddling the seam is handed to the head side; with the seam closed the
 * two arrays render as one sequence, so the choice settles the arithmetic
 * rather than the output.
 */
export function groupTimelineSides(
  above: TimelineItem[],
  below: TimelineItem[],
  opts: { gap: boolean; isRevealed?: (key: string) => boolean },
): { above: RenderUnit[]; below: RenderUnit[] } {
  if (opts.gap) {
    return {
      above: groupTimeline(above, opts.isRevealed),
      below: groupTimeline(below, opts.isRevealed),
    };
  }
  const units = groupTimeline([...above, ...below], opts.isRevealed);
  let seen = 0;
  let cut = 0;
  for (const unit of units) {
    if (seen >= above.length) break;
    seen += unitSize(unit);
    cut++;
  }
  return { above: units.slice(0, cut), below: units.slice(cut) };
}

/** Tolerant name extraction shared with describeEvent — bad payloads render "?". */
export const asName = (v: unknown): string =>
  typeof v === "object" && v !== null && "name" in v
    ? String((v as { name: unknown }).name)
    : "?";

/** One end of a hop, as the payload spells it — the id is what lets the
    summary look the status up and render it as a pill. */
export type StatusEnd = { id: number | null; name: string };

const UNKNOWN_END: StatusEnd = { id: null, name: "?" };

const asStatusEnd = (v: unknown): StatusEnd => {
  const id =
    typeof v === "object" && v !== null && "id" in v
      ? (v as { id: unknown }).id
      : null;
  return { id: typeof id === "number" ? id : null, name: asName(v) };
};

export type StatusChain = {
  hops: { from: StatusEnd; to: StatusEnd }[];
  net: { from: StatusEnd; to: StatusEnd };
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
    from: asStatusEnd(e.payload.from),
    to: asStatusEnd(e.payload.to),
  }));
  const net = {
    from: hops[0]?.from ?? UNKNOWN_END,
    to: hops[hops.length - 1]?.to ?? UNKNOWN_END,
  };
  const isNoop =
    net.from.id !== null && net.to.id !== null
      ? net.from.id === net.to.id
      : net.from.name === net.to.name;
  return { hops, net, isNoop };
}

const field = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null && key in v
    ? (v as Record<string, unknown>)[key]
    : undefined;

/** Identity as resolveUser resolves it — the member id where the payload has
    one, the login otherwise, so a ghost that lost its id is never counted as
    the member who still has it. */
const assigneeKey = (user: unknown): string => {
  const id = field(user, "id");
  if (typeof id === "number") return `#${id}`;
  const login = field(user, "login");
  return `@${typeof login === "string" ? login : "?"}`;
};

type AssigneeSide = "added" | "removed";

export type AssigneeChain = {
  /** Everyone the run touched, once per side, in first-appearance order. */
  touched: Record<AssigneeSide, unknown[]>;
  /** What the run leaves behind, round trips cancelled out. */
  net: Record<AssigneeSide, unknown[]>;
  /** Everyone the run touched ended where they started. */
  isNoop: boolean;
};

/**
 * An assignment run collapses to its net effect: one picker gesture that
 * takes a card off A, tries B and settles on C reads as A out, C in.
 *
 * Each user's direction comes from their first and last event rather than
 * from counting their events, so a payload that repeats a direction — two
 * `assigned A` with no `unassigned A` between them — still reports A as
 * assigned, where parity would erase them.
 *
 * The buckets hold payload users as they were written; resolving them into
 * chips is the summary's job, as netStatusChain leaves the pills to
 * resolveStatus.
 */
export function netAssignees(events: TimelineEvent[]): AssigneeChain {
  const touched: AssigneeChain["touched"] = { added: [], removed: [] };
  const listed: Record<AssigneeSide, Set<string>> = {
    added: new Set(),
    removed: new Set(),
  };
  const ends = new Map<
    string,
    { user: unknown; first: AssigneeSide; last: AssigneeSide }
  >();

  for (const event of events) {
    const side: AssigneeSide =
      event.event_type === "assigned" ? "added" : "removed";
    const user = event.payload.user;
    const key = assigneeKey(user);
    const seen = ends.get(key);
    if (seen) seen.last = side;
    else ends.set(key, { user, first: side, last: side });
    if (!listed[side].has(key)) {
      listed[side].add(key);
      touched[side].push(user);
    }
  }

  const net: AssigneeChain["net"] = { added: [], removed: [] };
  for (const end of ends.values()) {
    if (end.first === end.last) net[end.last].push(end.user);
  }
  return {
    touched,
    net,
    isNoop: net.added.length === 0 && net.removed.length === 0,
  };
}
