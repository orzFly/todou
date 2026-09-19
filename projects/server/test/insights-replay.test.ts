import { describe, expect, it } from "vitest";
import { aggregateInsights } from "../src/services/insights/aggregate.ts";
import {
  type ReplayEvent,
  replayIssue,
} from "../src/services/insights/replay.ts";

/**
 * Static input for the production replay tests added with the aggregator.
 * Keep this event stream independent from production constructors so a bug in
 * replay cannot rewrite its own oracle.
 */
const INSIGHTS_REPLAY_STATUSES = [
  {
    id: 1,
    name: "Todo",
    category: "open",
    role: "remaining",
    position: 0,
  },
  {
    id: 2,
    name: "Shipped",
    category: "open",
    role: "completed",
    position: 1,
  },
  {
    id: 3,
    name: "Done",
    category: "closed",
    role: "completed",
    position: 2,
  },
  {
    id: 4,
    name: "Invalid",
    category: "closed",
    role: "excluded",
    position: 3,
  },
] as const;

const INSIGHTS_REPLAY_EVENTS = [
  {
    sequence: 1,
    at: "2026-01-01T09:00:00Z",
    issue: "a",
    type: "created",
    status_id: 1,
  },
  {
    sequence: 2,
    at: "2026-01-01T09:01:00Z",
    issue: "b",
    type: "created",
    status_id: 1,
  },
  {
    sequence: 3,
    at: "2026-01-01T09:02:00Z",
    issue: "c",
    type: "created",
    status_id: 2,
  },
  {
    sequence: 4,
    at: "2026-01-01T09:03:00Z",
    issue: "d",
    type: "created",
    status_id: 3,
  },
  {
    sequence: 5,
    at: "2026-01-02T10:00:00Z",
    issue: "a",
    type: "status_changed",
    from_status_id: 1,
    to_status_id: 2,
  },
  {
    sequence: 6,
    at: "2026-01-02T10:01:00Z",
    issue: "e",
    type: "created",
    status_id: 1,
  },
  {
    sequence: 7,
    at: "2026-01-02T10:02:00Z",
    issue: "f",
    type: "created",
    status_id: 4,
  },
  {
    sequence: 8,
    at: "2026-01-03T11:00:00Z",
    issue: "a",
    type: "status_changed",
    from_status_id: 2,
    to_status_id: 3,
  },
  {
    sequence: 9,
    at: "2026-01-03T11:00:00Z",
    issue: "b",
    type: "status_changed",
    from_status_id: 1,
    to_status_id: 2,
  },
  {
    sequence: 10,
    at: "2026-01-03T11:00:00Z",
    issue: "b",
    type: "status_changed",
    from_status_id: 2,
    to_status_id: 1,
  },
  {
    sequence: 11,
    at: "2026-01-03T11:00:00Z",
    issue: "b",
    type: "status_changed",
    from_status_id: 1,
    to_status_id: 2,
  },
  {
    sequence: 12,
    at: "2026-01-03T11:00:00Z",
    issue: "c",
    type: "status_changed",
    from_status_id: 2,
    to_status_id: 3,
  },
  {
    sequence: 13,
    at: "2026-01-03T11:00:00Z",
    issue: "e",
    type: "status_changed",
    from_status_id: 1,
    to_status_id: 4,
  },
  {
    sequence: 14,
    at: "2026-01-03T11:00:00Z",
    issue: "f",
    type: "status_changed",
    from_status_id: 4,
    to_status_id: 1,
  },
  {
    sequence: 15,
    at: "2026-01-04T12:00:00Z",
    issue: "f",
    type: "status_changed",
    from_status_id: 1,
    to_status_id: 3,
  },
  {
    sequence: 16,
    at: "2026-01-04T12:01:00Z",
    issue: "b",
    type: "status_changed",
    from_status_id: 2,
    to_status_id: 3,
  },
] as const;

/** Hand-calculated values from the approved four-day a/b/c/d/e/f scenario. */
const INSIGHTS_REPLAY_ORACLE = [
  {
    day: "2026-01-01",
    remaining: 2,
    completed: 0,
    completed_cards: 0,
    reopened: 0,
    open_total: 3,
    created_completed: 2,
    category_closed: 0,
    category_reopened: 0,
    closed_by_status: { Done: 0, Invalid: 0 },
  },
  {
    day: "2026-01-02",
    remaining: 2,
    completed: 1,
    completed_cards: 1,
    reopened: 0,
    open_total: 4,
    created_completed: 0,
    category_closed: 0,
    category_reopened: 0,
    closed_by_status: { Done: 0, Invalid: 0 },
  },
  {
    day: "2026-01-03",
    remaining: 1,
    completed: 2,
    completed_cards: 1,
    reopened: 1,
    open_total: 2,
    created_completed: 0,
    category_closed: 3,
    category_reopened: 1,
    closed_by_status: { Done: 2, Invalid: 1 },
  },
  {
    day: "2026-01-04",
    remaining: 0,
    completed: 1,
    completed_cards: 1,
    reopened: 0,
    open_total: 0,
    created_completed: 0,
    category_closed: 2,
    category_reopened: 0,
    closed_by_status: { Done: 2, Invalid: 0 },
  },
] as const;

const INSIGHTS_REPLAY_FIXTURE = {
  timezone: "UTC",
  cohort: ["a", "b", "c", "d", "e", "f"],
  statuses: INSIGHTS_REPLAY_STATUSES,
  events: INSIGHTS_REPLAY_EVENTS,
  oracle: INSIGHTS_REPLAY_ORACLE,
} as const;

describe("insights replay fixture contract", () => {
  it("preserves the handwritten four-day oracle for production hookup", () => {
    expect(INSIGHTS_REPLAY_FIXTURE.cohort).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(INSIGHTS_REPLAY_ORACLE.map((day) => day.remaining)).toEqual([
      2, 2, 1, 0,
    ]);
    expect(INSIGHTS_REPLAY_ORACLE.map((day) => day.completed)).toEqual([
      0, 1, 2, 1,
    ]);
    expect(INSIGHTS_REPLAY_ORACLE.map((day) => day.reopened)).toEqual([
      0, 0, 1, 0,
    ]);
    expect(INSIGHTS_REPLAY_ORACLE.map((day) => day.open_total)).toEqual([
      3, 4, 2, 0,
    ]);
  });

  it("keeps every event status reference inside the fixture definition", () => {
    const statusIds = new Set<number>(
      INSIGHTS_REPLAY_STATUSES.map((status) => status.id),
    );
    const referencedStatusIds = INSIGHTS_REPLAY_EVENTS.flatMap((event) =>
      event.type === "created"
        ? [event.status_id]
        : [event.from_status_id, event.to_status_id],
    );

    expect(referencedStatusIds.every((id) => statusIds.has(id))).toBe(true);
    expect(INSIGHTS_REPLAY_EVENTS.map((event) => event.sequence)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
  });
});

describe("insights replay and aggregate", () => {
  it("matches the handwritten oracle and keeps A independent from D", () => {
    const eventsByIssue = new Map<
      string,
      (typeof INSIGHTS_REPLAY_EVENTS)[number][]
    >();
    for (const event of INSIGHTS_REPLAY_EVENTS) {
      const list = eventsByIssue.get(event.issue) ?? [];
      list.push(event);
      eventsByIssue.set(event.issue, list);
    }
    const issues = INSIGHTS_REPLAY_FIXTURE.cohort.map((name, index) => {
      const events = eventsByIssue.get(name) ?? [];
      const created = events.find((event) => event.type === "created");
      if (!created || created.type !== "created")
        throw new Error("missing creation");
      const last = events.at(-1);
      if (!last) throw new Error("missing final event");
      const finalStatus =
        last.type === "created" ? last.status_id : last.to_status_id;
      const transitions: ReplayEvent[] = [];
      for (const event of events) {
        if (event.type === "created") {
          transitions.push({
            id: event.sequence,
            type: "opened",
            createdAt: new Date(event.at),
            payload: {},
          });
        } else {
          transitions.push({
            id: event.sequence,
            type: "status_changed",
            createdAt: new Date(event.at),
            payload: {
              from: { id: event.from_status_id, name: "fixture" },
              to: { id: event.to_status_id, name: "fixture" },
            },
          });
        }
      }
      return replayIssue(
        {
          id: index + 1,
          createdAt: new Date(created.at),
          statusId: finalStatus,
        },
        transitions,
      );
    });
    const statuses = INSIGHTS_REPLAY_STATUSES.map((status) => ({
      status_id: status.id,
      name: status.name,
      category: status.category,
      role: status.role,
      position: status.position,
      color: "#336699",
    }));
    const result = aggregateInsights({
      statuses,
      issues,
      from: new Date("2026-01-01T00:00:00Z"),
      projectCreatedAt: new Date("2025-12-31T00:00:00Z"),
      buckets: [1, 2, 3, 4].map((day) => ({
        start: new Date(`2026-01-0${day}T00:00:00Z`),
        end: new Date(`2026-01-0${day + 1}T00:00:00Z`),
        partial: false,
        current: false,
      })),
    });
    expect(
      result.buckets.map((bucket) => bucket.stock?.remaining.value),
    ).toEqual(INSIGHTS_REPLAY_ORACLE.map((day) => day.remaining));
    expect(
      result.buckets.map((bucket) => bucket.flow?.completed.value),
    ).toEqual(INSIGHTS_REPLAY_ORACLE.map((day) => day.completed));
    expect(
      result.buckets.map((bucket) => bucket.flow?.completed_cards.value),
    ).toEqual(INSIGHTS_REPLAY_ORACLE.map((day) => day.completed_cards));
    expect(result.buckets.map((bucket) => bucket.flow?.reopened.value)).toEqual(
      INSIGHTS_REPLAY_ORACLE.map((day) => day.reopened),
    );
    expect(
      result.buckets.map((bucket) => bucket.stock?.open_total.value),
    ).toEqual(INSIGHTS_REPLAY_ORACLE.map((day) => day.open_total));
    expect(
      result.buckets.map((bucket) => bucket.flow?.category_closed.value),
    ).toEqual(INSIGHTS_REPLAY_ORACLE.map((day) => day.category_closed));
    expect(
      result.buckets.map((bucket) => bucket.flow?.category_reopened.value),
    ).toEqual(INSIGHTS_REPLAY_ORACLE.map((day) => day.category_reopened));
    expect(
      result.buckets.map((bucket) =>
        Object.fromEntries(
          (bucket.flow?.closed_by_status ?? []).map((entry) => [
            statuses.find((status) => status.status_id === entry.status_id)
              ?.name,
            entry.count.value,
          ]),
        ),
      ),
    ).toEqual(INSIGHTS_REPLAY_ORACLE.map((day) => day.closed_by_status));

    // Mutation sentinels: these values go red if A completion follows
    // category=closed, D follows A roles, flow becomes a stock delta, or
    // opened cards are forced into a default status.
    expect(result.buckets[1].flow?.completed.value).toBe(1);
    expect(result.buckets[0].stock?.open_total.value).toBe(3);
    expect(result.buckets[2].flow?.completed.value).toBe(2);
    expect(result.buckets[0].flow?.created_completed.value).toBe(2);
  });

  it("marks every affected flow family unknown when status classification is missing", () => {
    const issue = replayIssue(
      {
        id: 1,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        statusId: 99,
      },
      [
        {
          id: 1,
          type: "opened",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          payload: {},
        },
      ],
    );
    const result = aggregateInsights({
      statuses: [
        {
          status_id: 1,
          name: "Todo",
          category: "open",
          role: "remaining",
          position: 0,
          color: "#336699",
        },
        {
          status_id: 2,
          name: "Done",
          category: "closed",
          role: "completed",
          position: 1,
          color: "#22aa66",
        },
      ],
      issues: [issue],
      from: new Date("2026-01-01T00:00:00Z"),
      projectCreatedAt: new Date("2025-12-31T00:00:00Z"),
      buckets: [
        {
          start: new Date("2026-01-01T00:00:00Z"),
          end: new Date("2026-01-02T00:00:00Z"),
          partial: false,
          current: false,
        },
      ],
    });
    const flow = result.buckets[0]?.flow;
    expect(flow?.created_remaining).toEqual({
      value: null,
      known: 0,
      unknown: 1,
    });
    expect(flow?.created_completed).toEqual({
      value: null,
      known: 0,
      unknown: 1,
    });
    expect(flow?.scope_added).toEqual({ value: null, known: 0, unknown: 1 });
    expect(flow?.created_open).toEqual({ value: null, known: 0, unknown: 1 });
    expect(flow?.open_entered).toEqual({ value: null, known: 0, unknown: 1 });
  });

  it("reports a deleted intermediate status only in the bucket it crosses", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const issue = replayIssue({ id: 1, createdAt: start, statusId: 3 }, [
      { id: 1, createdAt: start, type: "opened", payload: {} },
      {
        id: 2,
        createdAt: new Date("2026-01-02T08:00:00Z"),
        type: "status_changed",
        payload: { from: { id: 1 }, to: { id: 2 } },
      },
      {
        id: 3,
        createdAt: new Date("2026-01-02T09:00:00Z"),
        type: "closed",
        payload: { from: { id: 2 }, to: { id: 3 } },
      },
    ]);
    const result = aggregateInsights({
      statuses: [
        {
          status_id: 1,
          name: "Todo",
          category: "open",
          color: "#336699",
          position: 0,
          role: "remaining",
        },
        {
          status_id: 3,
          name: "Done",
          category: "closed",
          color: "#22aa66",
          position: 2,
          role: "completed",
        },
      ],
      issues: [issue],
      from: start,
      projectCreatedAt: start,
      buckets: [1, 2, 3].map((day) => ({
        start: new Date(`2026-01-0${day}T00:00:00Z`),
        end: new Date(`2026-01-0${day + 1}T00:00:00Z`),
        partial: false,
        current: false,
      })),
    });
    expect(result.buckets.map((bucket) => bucket.quality)).toEqual([
      "exact",
      "mixed",
      "exact",
    ]);
    expect(result.buckets.map((bucket) => bucket.reasons)).toEqual([
      [],
      ["missing_status_definition"],
      [],
    ]);
    expect(result.buckets[1]?.flow?.completed).toEqual({
      value: null,
      known: 0,
      unknown: 2,
    });
    expect(result.reasons).toEqual(["missing_status_definition"]);
  });

  it("attributes an uncertain earlier interval to a later broken chain", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const issue = replayIssue({ id: 1, createdAt: start, statusId: 2 }, [
      { id: 1, createdAt: start, type: "opened", payload: {} },
      {
        id: 2,
        createdAt: new Date("2026-01-04T12:00:00Z"),
        type: "closed",
        payload: { from: { id: 1 }, to: { id: 3 } },
      },
    ]);
    const result = aggregateInsights({
      statuses: [
        {
          status_id: 1,
          name: "Todo",
          category: "open",
          color: "#336699",
          position: 0,
          role: "remaining",
        },
        {
          status_id: 2,
          name: "Shipped",
          category: "open",
          color: "#22aa66",
          position: 1,
          role: "completed",
        },
        {
          status_id: 3,
          name: "Done",
          category: "closed",
          color: "#445566",
          position: 2,
          role: "completed",
        },
      ],
      issues: [issue],
      from: start,
      projectCreatedAt: start,
      buckets: [1, 2, 3, 4].map((day) => ({
        start: new Date(`2026-01-0${day}T00:00:00Z`),
        end: new Date(`2026-01-0${day + 1}T00:00:00Z`),
        partial: false,
        current: false,
      })),
    });
    expect(result.buckets.map((bucket) => bucket.reasons)).toEqual([
      ["broken_transition_chain"],
      ["broken_transition_chain"],
      ["broken_transition_chain"],
      ["broken_transition_chain"],
    ]);
    expect(result.buckets[0]?.stock?.remaining.unknown).toBe(1);
    expect(result.buckets[3]?.stock?.remaining).toEqual({
      value: 0,
      known: 0,
      unknown: 0,
    });
    expect(result.reasons).toEqual(["broken_transition_chain"]);
  });

  it("starts at the latest moved_in and excludes copied events at the same millisecond", () => {
    const moveAt = new Date("2026-01-02T08:00:00Z");
    const moved = replayIssue(
      { id: 1, createdAt: new Date("2026-01-01T08:00:00Z"), statusId: 2 },
      [
        {
          id: 1,
          type: "opened",
          createdAt: new Date("2026-01-01T08:00:00Z"),
          payload: {},
        },
        {
          id: 4,
          type: "status_changed",
          createdAt: moveAt,
          payload: { from: { id: 99 }, to: { id: 1 } },
        },
        {
          id: 5,
          type: "moved_in",
          createdAt: moveAt,
          payload: { move_token: "fixture-move" },
        },
        {
          id: 6,
          type: "status_changed",
          createdAt: moveAt,
          payload: { from: { id: 1 }, to: { id: 2 } },
        },
      ],
    );
    expect(moved.membershipStart).toEqual(moveAt);
    expect(moved.membershipStartEventId).toBe(5);
    expect(moved.initialStatusId).toBe(1);
    expect(moved.points.map((point) => point.id)).toEqual([5, 6]);
    expect(moved.points.every((point) => point.reason === undefined)).toBe(
      true,
    );
  });

  it("aggregates membership_boundary_unknown only from the move onward", () => {
    const moveAt = new Date("2026-01-02T08:00:00Z");

    const unknownBoundary = replayIssue(
      { id: 2, createdAt: moveAt, statusId: 1 },
      [{ id: 7, type: "moved_in", createdAt: moveAt, payload: {} }],
    );
    expect(unknownBoundary.points[0]).toMatchObject({
      known: false,
      reason: "membership_boundary_unknown",
    });
    const result = aggregateInsights({
      statuses: [
        {
          status_id: 1,
          name: "Todo",
          category: "open",
          color: "#336699",
          position: 0,
          role: "remaining",
        },
      ],
      issues: [unknownBoundary],
      from: new Date("2026-01-01T00:00:00Z"),
      projectCreatedAt: new Date("2026-01-01T00:00:00Z"),
      buckets: [1, 2, 3].map((day) => ({
        start: new Date(`2026-01-0${day}T00:00:00Z`),
        end: new Date(`2026-01-0${day + 1}T00:00:00Z`),
        partial: false,
        current: false,
      })),
    });
    const unknown = { value: null, known: 0, unknown: 1 };
    const zero = { value: 0, known: 0, unknown: 0 };
    expect(result.reasons).toEqual(["membership_boundary_unknown"]);
    expect(result.buckets.map((bucket) => bucket.reasons)).toEqual([
      [],
      ["membership_boundary_unknown"],
      ["membership_boundary_unknown"],
    ]);
    expect(result.buckets.map((bucket) => bucket.quality)).toEqual([
      "exact",
      "unknown",
      "unknown",
    ]);
    expect(result.buckets[0]?.stock?.remaining).toEqual(zero);
    expect(result.buckets[1]?.stock).toMatchObject({
      remaining: unknown,
      scope: unknown,
      open_total: unknown,
      unknown_cards: 1,
    });
    expect(result.buckets[1]?.flow).toMatchObject({
      moved_in_remaining: unknown,
      moved_in_completed: unknown,
      moved_in_open: unknown,
      scope_added: unknown,
      open_entered: unknown,
      created_remaining: zero,
      completed: zero,
    });
    // Stock uncertainty persists, but the entry is counted only on move day.
    expect(result.buckets[2]?.stock?.remaining).toEqual(unknown);
    expect(result.buckets[2]?.flow?.moved_in_remaining).toEqual(zero);
  });

  it("removes temporarily deleted stock and restores without a completion", () => {
    const created = new Date("2026-01-01T08:00:00Z");
    const issue = replayIssue({ id: 1, createdAt: created, statusId: 1 }, [
      { id: 1, type: "opened", createdAt: created, payload: {} },
      {
        id: 2,
        type: "deleted",
        createdAt: new Date("2026-01-02T08:00:00Z"),
        payload: {},
      },
      {
        id: 3,
        type: "restored",
        createdAt: new Date("2026-01-03T08:00:00Z"),
        payload: {},
      },
    ]);
    const result = aggregateInsights({
      statuses: [
        {
          status_id: 1,
          name: "Todo",
          category: "open",
          color: "#336699",
          position: 0,
          role: "remaining",
        },
      ],
      issues: [issue],
      from: new Date("2026-01-01T00:00:00Z"),
      projectCreatedAt: new Date("2026-01-01T00:00:00Z"),
      buckets: [1, 2, 3].map((day) => ({
        start: new Date(`2026-01-0${day}T00:00:00Z`),
        end: new Date(`2026-01-0${day + 1}T00:00:00Z`),
        partial: false,
        current: false,
      })),
    });
    expect(
      result.buckets.map((bucket) => bucket.stock?.remaining.value),
    ).toEqual([1, 0, 1]);
    expect(
      result.buckets.map((bucket) => bucket.flow?.deleted_remaining.value),
    ).toEqual([0, 1, 0]);
    expect(
      result.buckets.map((bucket) => bucket.flow?.restored_remaining.value),
    ).toEqual([0, 0, 1]);
    expect(
      result.buckets.map((bucket) => bucket.flow?.completed.value),
    ).toEqual([0, 0, 0]);
  });
});
