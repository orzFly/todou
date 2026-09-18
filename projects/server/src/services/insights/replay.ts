export type ReplayReason =
  | "missing_status_definition"
  | "broken_transition_chain"
  | "membership_boundary_unknown"
  | "malformed_event";

export type ReplayIssue = {
  id: number;
  createdAt: Date;
  statusId: number;
};

export type ReplayEvent = {
  id: number;
  type:
    | "opened"
    | "closed"
    | "reopened"
    | "status_changed"
    | "deleted"
    | "restored"
    | "moved_in"
    | string;
  createdAt: Date;
  payload: unknown;
};

export type ReplayPoint = {
  id: number;
  at: Date;
  kind: "created" | "moved_in" | "status" | "deleted" | "restored";
  beforeStatusId: number | null;
  afterStatusId: number | null;
  known: boolean;
  reason?: ReplayReason;
};

export type ReplayedIssue = {
  issueId: number;
  membershipStart: Date;
  membershipStartEventId: number | null;
  initialStatusId: number | null;
  points: ReplayPoint[];
  reasons: ReplayReason[];
};

function compareEvent(a: ReplayEvent, b: ReplayEvent): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;
}

function statusPair(
  payload: unknown,
): { from: number | null; to: number } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as { from?: unknown; to?: unknown };
  if (typeof value.to !== "object" || value.to === null) return null;
  const to = (value.to as { id?: unknown }).id;
  if (typeof to !== "number" || !Number.isSafeInteger(to) || to <= 0) {
    return null;
  }
  if (value.from === null) return { from: null, to };
  if (typeof value.from !== "object" || value.from === null) return null;
  const from = (value.from as { id?: unknown }).id;
  if (typeof from !== "number" || !Number.isSafeInteger(from) || from <= 0) {
    return null;
  }
  return { from, to };
}

const STATUS_EVENTS = new Set(["closed", "reopened", "status_changed"]);

/**
 * Reconstruct one current live card's current project-membership segment.
 * The status chain is deliberately walked backwards from the live row: an
 * `opened` event has no status payload and therefore cannot define the initial
 * state of a card created directly in a non-default status.
 */
export function replayIssue(
  issue: ReplayIssue,
  input: ReplayEvent[],
): ReplayedIssue {
  const events = [...input].sort(compareEvent);
  const movedIn = events.filter((event) => event.type === "moved_in").at(-1);
  const membershipStart = movedIn?.createdAt ?? issue.createdAt;
  const membershipStartEventId = movedIn?.id ?? null;
  const inMembership = events.filter((event) => {
    const delta = event.createdAt.getTime() - membershipStart.getTime();
    if (delta > 0) return true;
    if (delta < 0) return false;
    return (
      membershipStartEventId === null || event.id >= membershipStartEventId
    );
  });
  const transitions = inMembership.filter((event) =>
    STATUS_EVENTS.has(event.type),
  );
  const reasons = new Set<ReplayReason>();
  const statusPoints = new Map<number, ReplayPoint>();
  let cursor: number | null = issue.statusId;

  for (const event of [...transitions].reverse()) {
    const pair = statusPair(event.payload);
    if (pair === null) {
      reasons.add("malformed_event");
      statusPoints.set(event.id, {
        id: event.id,
        at: event.createdAt,
        kind: "status",
        beforeStatusId: null,
        afterStatusId: cursor,
        known: false,
        reason: "malformed_event",
      });
      cursor = null;
      continue;
    }
    if (cursor !== null && pair.to !== cursor) {
      reasons.add("broken_transition_chain");
      statusPoints.set(event.id, {
        id: event.id,
        at: event.createdAt,
        kind: "status",
        beforeStatusId: null,
        afterStatusId: cursor,
        known: false,
        reason: "broken_transition_chain",
      });
      cursor = null;
      continue;
    }
    statusPoints.set(event.id, {
      id: event.id,
      at: event.createdAt,
      kind: "status",
      beforeStatusId: pair.from,
      afterStatusId: pair.to,
      known: cursor !== null,
      ...(cursor === null
        ? { reason: "broken_transition_chain" as const }
        : {}),
    });
    if (cursor === null) reasons.add("broken_transition_chain");
    cursor = cursor === null ? null : pair.from;
  }

  const entry: ReplayPoint = {
    id: membershipStartEventId ?? Number.MIN_SAFE_INTEGER,
    at: membershipStart,
    kind: movedIn === undefined ? "created" : "moved_in",
    beforeStatusId: null,
    afterStatusId: cursor,
    known: cursor !== null,
    ...(cursor === null ? { reason: "broken_transition_chain" as const } : {}),
  };
  const lifecycle = inMembership.flatMap((event): ReplayPoint[] => {
    if (event.type !== "deleted" && event.type !== "restored") return [];
    return [
      {
        id: event.id,
        at: event.createdAt,
        kind: event.type,
        beforeStatusId: null,
        afterStatusId: null,
        known: true,
      },
    ];
  });
  const points = [entry, ...statusPoints.values(), ...lifecycle].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id,
  );

  return {
    issueId: issue.id,
    membershipStart,
    membershipStartEventId,
    initialStatusId: cursor,
    points,
    reasons: [...reasons],
  };
}
