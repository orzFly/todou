import { describe, expect, it } from "vitest";

import {
  Bucket,
  BurnQuery,
  BurnResponse,
  Flow,
  Grain,
  Measure,
  PutSettings,
  Role,
  Settings,
  StockSnapshot,
} from "../src/index.ts";

const exactZero = { value: 0, known: 0, unknown: 0 } as const;
const exact = (value: number) => ({ value, known: value, unknown: 0 });

const stock = StockSnapshot.parse({
  remaining: exact(2),
  scope: exact(4),
  open_total: exact(3),
  by_status: [
    { status_id: 1, count: 2 },
    { status_id: 2, count: 1 },
    { status_id: 3, count: 1 },
  ],
  unknown_cards: 0,
});

const flow = Flow.parse({
  completed: exact(1),
  completed_cards: exact(1),
  reopened: exactZero,
  created_remaining: exact(2),
  created_completed: exact(1),
  moved_in_remaining: exactZero,
  moved_in_completed: exactZero,
  restored_remaining: exactZero,
  restored_completed: exactZero,
  reintroduced_remaining: exactZero,
  reintroduced_completed: exactZero,
  excluded_remaining: exactZero,
  excluded_completed: exactZero,
  deleted_remaining: exactZero,
  deleted_completed: exactZero,
  scope_added: exact(3),
  scope_removed: exactZero,
  open_entered: exact(3),
  open_exited: exactZero,
  category_closed: exactZero,
  category_reopened: exactZero,
  created_open: exact(3),
  moved_in_open: exactZero,
  restored_open: exactZero,
  deleted_open: exactZero,
  closed_by_status: [
    { status_id: 3, count: exactZero },
    { status_id: 4, count: exactZero },
  ],
});

const roles = [
  {
    status_id: 1,
    name: "Todo",
    category: "open" as const,
    color: "#336699",
    position: 0,
    role: "remaining" as const,
  },
  {
    status_id: 2,
    name: "Shipped",
    category: "open" as const,
    color: "#22aa66",
    position: 1,
    role: "completed" as const,
  },
  {
    status_id: 3,
    name: "Done",
    category: "closed" as const,
    color: "#445566",
    position: 2,
    role: "completed" as const,
  },
  {
    status_id: 4,
    name: "Invalid",
    category: "closed" as const,
    color: "#999999",
    position: 3,
    role: "excluded" as const,
  },
];

describe("insights enums and requests", () => {
  it("accepts only the contracted roles and grains", () => {
    expect(Role.safeParse("remaining").success).toBe(true);
    expect(Role.safeParse("cancelled").success).toBe(false);
    expect(Grain.safeParse("6h").success).toBe(true);
    expect(Grain.safeParse("2h").success).toBe(false);
  });

  it("requires matching, ordered date or timestamp boundaries", () => {
    expect(
      BurnQuery.safeParse({
        from: "2026-01-01",
        to: "2026-01-08",
        grain: "1d",
        tz: "Asia/Shanghai",
      }).success,
    ).toBe(true);
    expect(
      BurnQuery.safeParse({
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00+00:00",
        grain: "1h",
        tz: "UTC",
      }).success,
    ).toBe(true);

    for (const query of [
      {
        from: "2026-01-01",
        to: "2026-01-02T00:00:00Z",
        grain: "1d",
        tz: "UTC",
      },
      {
        from: "2026-01-02",
        to: "2026-01-01",
        grain: "1d",
        tz: "UTC",
      },
      {
        from: "2026-01-01",
        to: "2027-01-03",
        grain: "1w",
        tz: "UTC",
      },
      {
        from: "2026-01-01",
        to: "2026-01-02",
        grain: "1d",
        tz: "UTC",
        surprise: true,
      },
    ]) {
      expect(BurnQuery.safeParse(query).success).toBe(false);
    }
  });

  it("keeps settings strict and rejects duplicate status mappings", () => {
    expect(
      Settings.safeParse({ version: "revision:1", source: "default", roles })
        .success,
    ).toBe(true);
    expect(
      PutSettings.safeParse({
        version: "revision:1",
        roles: [
          { status_id: 1, role: "remaining" },
          { status_id: 1, role: "completed" },
        ],
      }).success,
    ).toBe(false);
    expect(
      PutSettings.safeParse({
        version: "revision:1",
        roles: [{ status_id: 1, role: "remaining", name: "Todo" }],
      }).success,
    ).toBe(false);
  });
});

describe("Measure", () => {
  it("exposes value only when no part of the measure is unknown", () => {
    expect(Measure.parse(exact(12))).toEqual({
      value: 12,
      known: 12,
      unknown: 0,
    });
    expect(Measure.parse({ value: null, known: 12, unknown: 2 })).toEqual({
      value: null,
      known: 12,
      unknown: 2,
    });

    for (const measure of [
      { value: null, known: 12, unknown: 0 },
      { value: 12, known: 12, unknown: 1 },
      { value: 11, known: 12, unknown: 0 },
      { value: -1, known: -1, unknown: 0 },
      { value: 1.5, known: 1.5, unknown: 0 },
      {
        value: Number.MAX_SAFE_INTEGER + 1,
        known: Number.MAX_SAFE_INTEGER + 1,
        unknown: 0,
      },
    ]) {
      expect(Measure.safeParse(measure).success).toBe(false);
    }
  });
});

describe("buckets and burn responses", () => {
  it("keeps partial time coverage independent from exact data quality", () => {
    expect(
      Bucket.safeParse({
        start: "2026-01-01T06:00:00Z",
        end: "2026-01-02T00:00:00Z",
        partial: true,
        current: false,
        quality: "exact",
        reasons: [],
        stock,
        flow,
      }).success,
    ).toBe(true);
  });

  it("pairs not_applicable only with null stock and flow", () => {
    const base = {
      start: "2025-12-31T00:00:00Z",
      end: "2026-01-01T00:00:00Z",
      partial: false,
      current: false,
      reasons: [],
    };
    expect(
      Bucket.safeParse({
        ...base,
        quality: "not_applicable",
        stock: null,
        flow: null,
      }).success,
    ).toBe(true);
    expect(
      Bucket.safeParse({
        ...base,
        quality: "exact",
        stock: null,
        flow: null,
      }).success,
    ).toBe(false);
    expect(
      Bucket.safeParse({
        ...base,
        quality: "not_applicable",
        stock,
        flow,
      }).success,
    ).toBe(false);
  });

  it("accepts a representative complete response with snake_case fields", () => {
    const response = {
      as_of: "2026-01-02T12:00:00Z",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T12:00:00Z",
      requested_grain: "auto",
      resolved_grain: "1d",
      timezone: "UTC",
      settings_version: "revision:1:statuses:abc",
      cohort: { mode: "current", count: 4 },
      history_coverage: {
        project_created_at: "2025-12-31T12:00:00Z",
        mode: "current_cohort",
        has_unknown: false,
        reasons: [],
      },
      statuses: roles,
      opening: stock,
      buckets: [
        {
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-02T00:00:00Z",
          partial: false,
          current: false,
          quality: "exact",
          reasons: [],
          stock,
          flow,
        },
        {
          start: "2026-01-02T00:00:00Z",
          end: "2026-01-02T12:00:00Z",
          partial: true,
          current: true,
          quality: "mixed",
          reasons: ["broken_transition_chain"],
          stock: {
            ...stock,
            remaining: { value: null, known: 1, unknown: 1 },
            unknown_cards: 1,
          },
          flow,
        },
      ],
    };

    expect(BurnResponse.parse(response)).toEqual(response);
  });
});
