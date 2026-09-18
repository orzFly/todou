import type {
  Bucket,
  CoverageReason,
  Flow,
  Measure,
  Role,
  RoleEntry,
  StockSnapshot,
} from "@todou/shared";
import type { ReplayedIssue, ReplayPoint } from "./replay.ts";

export type AggregateBucket = {
  start: Date;
  end: Date;
  partial: boolean;
  current: boolean;
};

export type AggregateInput = {
  statuses: RoleEntry[];
  issues: ReplayedIssue[];
  buckets: AggregateBucket[];
  from: Date;
  projectCreatedAt: Date;
};

type State = { present: boolean; statusId: number | null };
type MutableFlow = {
  [K in Exclude<keyof Flow, "closed_by_status">]: number;
} & {
  closed_by_status: Map<number, number>;
  unknownByKey: Map<NumericFlowKey, number>;
  unknownClosedByStatus: Map<number, number>;
  completedIssueIds: Set<number>;
  unknownCompletedIssueIds: Set<number>;
};

type TimedPoint = ReplayPoint & { issueId: number };

const FLOW_KEYS = [
  "completed",
  "completed_cards",
  "reopened",
  "created_remaining",
  "created_completed",
  "moved_in_remaining",
  "moved_in_completed",
  "restored_remaining",
  "restored_completed",
  "reintroduced_remaining",
  "reintroduced_completed",
  "excluded_remaining",
  "excluded_completed",
  "deleted_remaining",
  "deleted_completed",
  "scope_added",
  "scope_removed",
  "open_entered",
  "open_exited",
  "category_closed",
  "category_reopened",
  "created_open",
  "moved_in_open",
  "restored_open",
  "deleted_open",
] as const;

type NumericFlowKey = (typeof FLOW_KEYS)[number];


function measured(value: number, unknown: number): Measure {
  return unknown === 0
    ? { value, known: value, unknown: 0 }
    : { value: null, known: value, unknown };
}

function emptyFlow(): MutableFlow {
  return {
    completed: 0,
    completed_cards: 0,
    reopened: 0,
    created_remaining: 0,
    created_completed: 0,
    moved_in_remaining: 0,
    moved_in_completed: 0,
    restored_remaining: 0,
    restored_completed: 0,
    reintroduced_remaining: 0,
    reintroduced_completed: 0,
    excluded_remaining: 0,
    excluded_completed: 0,
    deleted_remaining: 0,
    deleted_completed: 0,
    scope_added: 0,
    scope_removed: 0,
    open_entered: 0,
    open_exited: 0,
    category_closed: 0,
    category_reopened: 0,
    created_open: 0,
    moved_in_open: 0,
    restored_open: 0,
    deleted_open: 0,
    closed_by_status: new Map(),
    unknownByKey: new Map(),
    unknownClosedByStatus: new Map(),
    completedIssueIds: new Set(),
    unknownCompletedIssueIds: new Set(),
  };
}

function increment(flow: MutableFlow, key: NumericFlowKey): void {
  flow[key] += 1;
}

const ENTRY_UNKNOWN_KEYS: Record<
  "created" | "moved_in" | "restored",
  NumericFlowKey[]
> = {
  created: [
    "created_remaining",
    "created_completed",
    "scope_added",
    "created_open",
    "open_entered",
  ],
  moved_in: [
    "moved_in_remaining",
    "moved_in_completed",
    "scope_added",
    "moved_in_open",
    "open_entered",
  ],
  restored: [
    "restored_remaining",
    "restored_completed",
    "scope_added",
    "restored_open",
    "open_entered",
  ],
};

const TRANSITION_UNKNOWN_KEYS: NumericFlowKey[] = [
  "completed",
  "completed_cards",
  "reopened",
  "reintroduced_remaining",
  "reintroduced_completed",
  "excluded_remaining",
  "excluded_completed",
  "scope_added",
  "scope_removed",
  "open_entered",
  "open_exited",
  "category_closed",
  "category_reopened",
];

function markUnknown(
  flow: MutableFlow,
  keys: NumericFlowKey[],
  issueId?: number,
): void {
  for (const key of keys) {
    flow.unknownByKey.set(key, (flow.unknownByKey.get(key) ?? 0) + 1);
  }
  if (issueId !== undefined && keys.includes("completed_cards")) {
    flow.unknownCompletedIssueIds.add(issueId);
  }
}

function classifyEntry(
  flow: MutableFlow,
  kind: "created" | "moved_in" | "restored",
  role: Role,
  open: boolean,
): void {
  if (role === "remaining") {
    increment(flow, `${kind}_remaining` as NumericFlowKey);
    increment(flow, "scope_added");
  } else if (role === "completed") {
    increment(flow, `${kind}_completed` as NumericFlowKey);
    increment(flow, "scope_added");
  }
  if (open) {
    increment(flow, `${kind}_open` as NumericFlowKey);
    increment(flow, "open_entered");
  }
}

function classifyExit(flow: MutableFlow, role: Role, open: boolean): void {
  if (role === "remaining") {
    increment(flow, "deleted_remaining");
    increment(flow, "scope_removed");
  } else if (role === "completed") {
    increment(flow, "deleted_completed");
    increment(flow, "scope_removed");
  }
  if (open) {
    increment(flow, "deleted_open");
    increment(flow, "open_exited");
  }
}

function classifyTransition(
  flow: MutableFlow,
  issueId: number,
  from: RoleEntry,
  to: RoleEntry,
): void {
  if (from.role === "remaining" && to.role === "completed") {
    increment(flow, "completed");
    flow.completedIssueIds.add(issueId);
  } else if (from.role === "completed" && to.role === "remaining") {
    increment(flow, "reopened");
  } else if (from.role === "excluded" && to.role === "remaining") {
    increment(flow, "reintroduced_remaining");
    increment(flow, "scope_added");
  } else if (from.role === "excluded" && to.role === "completed") {
    increment(flow, "reintroduced_completed");
    increment(flow, "scope_added");
  } else if (from.role === "remaining" && to.role === "excluded") {
    increment(flow, "excluded_remaining");
    increment(flow, "scope_removed");
  } else if (from.role === "completed" && to.role === "excluded") {
    increment(flow, "excluded_completed");
    increment(flow, "scope_removed");
  }

  if (from.category === "open" && to.category === "closed") {
    increment(flow, "category_closed");
    increment(flow, "open_exited");
    flow.closed_by_status.set(
      to.status_id,
      (flow.closed_by_status.get(to.status_id) ?? 0) + 1,
    );
  } else if (from.category === "closed" && to.category === "open") {
    increment(flow, "category_reopened");
    increment(flow, "open_entered");
  }
}

function finishFlow(flow: MutableFlow, statuses: RoleEntry[]): Flow {
  flow.completed_cards = flow.completedIssueIds.size;
  flow.unknownByKey.set("completed_cards", flow.unknownCompletedIssueIds.size);
  const result = Object.fromEntries(
    FLOW_KEYS.map((key) => [
      key,
      measured(flow[key], flow.unknownByKey.get(key) ?? 0),
    ]),
  ) as Omit<Flow, "closed_by_status">;
  return {
    ...result,
    closed_by_status: statuses
      .filter((status) => status.category === "closed")
      .map((status) => ({
        status_id: status.status_id,
        count: measured(
          flow.closed_by_status.get(status.status_id) ?? 0,
          flow.unknownClosedByStatus.get(status.status_id) ?? 0,
        ),
      })),
  };
}

function stockOf(
  states: Map<number, State>,
  statuses: RoleEntry[],
): StockSnapshot {
  const statusById = new Map(
    statuses.map((status) => [status.status_id, status]),
  );
  const counts = new Map(statuses.map((status) => [status.status_id, 0]));
  let remaining = 0;
  let scope = 0;
  let open = 0;
  let unknown = 0;
  for (const state of states.values()) {
    if (!state.present) continue;
    const status =
      state.statusId === null ? undefined : statusById.get(state.statusId);
    if (status === undefined) {
      unknown += 1;
      continue;
    }
    counts.set(status.status_id, (counts.get(status.status_id) ?? 0) + 1);
    if (status.role === "remaining") remaining += 1;
    if (status.role !== "excluded") scope += 1;
    if (status.category === "open") open += 1;
  }
  return {
    remaining: measured(remaining, unknown),
    scope: measured(scope, unknown),
    open_total: measured(open, unknown),
    by_status: statuses.map((status) => ({
      status_id: status.status_id,
      count: counts.get(status.status_id) ?? 0,
    })),
    unknown_cards: unknown,
  };
}

function applyPoint(
  point: TimedPoint,
  state: State,
  statusById: Map<number, RoleEntry>,
  flow?: MutableFlow,
): void {
  if (point.kind === "created" || point.kind === "moved_in") {
    state.present = true;
    state.statusId = point.afterStatusId;
    if (flow !== undefined) {
      const status =
        state.statusId === null ? undefined : statusById.get(state.statusId);
      if (status === undefined) {
        markUnknown(flow, ENTRY_UNKNOWN_KEYS[point.kind]);
      } else
        classifyEntry(
          flow,
          point.kind,
          status.role,
          status.category === "open",
        );
    }
    return;
  }
  if (point.kind === "deleted") {
    if (flow !== undefined && state.present) {
      const status =
        state.statusId === null ? undefined : statusById.get(state.statusId);
      if (status === undefined) {
        markUnknown(flow, [
          "deleted_remaining",
          "deleted_completed",
          "scope_removed",
          "deleted_open",
          "open_exited",
        ]);
      } else classifyExit(flow, status.role, status.category === "open");
    }
    state.present = false;
    return;
  }
  if (point.kind === "restored") {
    state.present = true;
    if (flow !== undefined) {
      const status =
        state.statusId === null ? undefined : statusById.get(state.statusId);
      if (status === undefined) {
        markUnknown(flow, ENTRY_UNKNOWN_KEYS.restored);
      } else
        classifyEntry(
          flow,
          "restored",
          status.role,
          status.category === "open",
        );
    }
    return;
  }

  if (flow !== undefined && state.present) {
    const from =
      point.beforeStatusId === null
        ? undefined
        : statusById.get(point.beforeStatusId);
    const to =
      point.afterStatusId === null
        ? undefined
        : statusById.get(point.afterStatusId);
    if (!point.known || from === undefined || to === undefined) {
      markUnknown(flow, TRANSITION_UNKNOWN_KEYS, point.issueId);
      const closedTargets =
        to?.category === "closed"
          ? [to.status_id]
          : [...statusById.values()]
              .filter((status) => status.category === "closed")
              .map((status) => status.status_id);
      for (const statusId of closedTargets) {
        flow.unknownClosedByStatus.set(
          statusId,
          (flow.unknownClosedByStatus.get(statusId) ?? 0) + 1,
        );
      }
    } else {
      classifyTransition(flow, point.issueId, from, to);
    }
  }
  state.statusId = point.afterStatusId;
}

function qualityOf(
  stock: StockSnapshot,
  reasons: CoverageReason[],
): Bucket["quality"] {
  if (stock.unknown_cards === 0 && reasons.length === 0) return "exact";
  const known = stock.by_status.reduce((sum, item) => sum + item.count, 0);
  return known === 0 ? "unknown" : "mixed";
}

export function aggregateInsights(input: AggregateInput): {
  opening: StockSnapshot | null;
  buckets: Bucket[];
  reasons: CoverageReason[];
} {
  const statusById = new Map(
    input.statuses.map((status) => [status.status_id, status]),
  );
  const states = new Map<number, State>();
  const points: TimedPoint[] = input.issues
    .flatMap((issue) =>
      issue.points.map((point) => ({ ...point, issueId: issue.issueId })),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  const reasons = [...new Set(input.issues.flatMap((issue) => issue.reasons))];
  let cursor = 0;
  while (cursor < points.length && points[cursor].at < input.from) {
    const point = points[cursor];
    const state = states.get(point.issueId) ?? {
      present: false,
      statusId: null,
    };
    applyPoint(point, state, statusById);
    states.set(point.issueId, state);
    cursor += 1;
  }
  const opening =
    input.from < input.projectCreatedAt
      ? null
      : stockOf(states, input.statuses);
  const buckets: Bucket[] = [];

  for (const boundary of input.buckets) {
    if (boundary.end <= input.projectCreatedAt) {
      buckets.push({
        start: boundary.start.toISOString(),
        end: boundary.end.toISOString(),
        partial: boundary.partial,
        current: boundary.current,
        quality: "not_applicable",
        reasons: [],
        stock: null,
        flow: null,
      });
      continue;
    }
    const flow = emptyFlow();
    while (cursor < points.length && points[cursor].at < boundary.end) {
      const point = points[cursor];
      const state = states.get(point.issueId) ?? {
        present: false,
        statusId: null,
      };
      applyPoint(
        point,
        state,
        statusById,
        point.at >= boundary.start ? flow : undefined,
      );
      states.set(point.issueId, state);
      cursor += 1;
    }
    const stock = stockOf(states, input.statuses);
    const bucketReasons = [
      ...new Set([
        ...reasons,
        ...(stock.unknown_cards > 0
          ? (["missing_status_definition"] as const)
          : []),
      ]),
    ];
    buckets.push({
      start: boundary.start.toISOString(),
      end: boundary.end.toISOString(),
      partial: boundary.partial || boundary.start < input.projectCreatedAt,
      current: boundary.current,
      quality: qualityOf(stock, bucketReasons),
      reasons: bucketReasons,
      stock,
      flow: finishFlow(flow, input.statuses),
    });
  }
  return { opening, buckets, reasons };
}
