import { describe, expect, it } from "vitest";
import {
  buildBuckets,
  fixedBoundaries,
  normalizeCalendarBoundaries,
} from "../src/services/insights/buckets.ts";

const noCalendar = async () => [];

describe("insights buckets", () => {
  it("uses UTC fixed grids and assigns exact end events to the next bucket", async () => {
    const from = new Date("2026-01-01T00:30:00Z");
    const to = new Date("2026-01-01T03:00:00Z");
    expect(
      fixedBoundaries(from, to, 60 * 60 * 1000).map((date) =>
        date.toISOString(),
      ),
    ).toEqual([
      "2026-01-01T00:30:00.000Z",
      "2026-01-01T01:00:00.000Z",
      "2026-01-01T02:00:00.000Z",
      "2026-01-01T03:00:00.000Z",
    ]);
    const result = await buildBuckets({
      from,
      to,
      asOf: to,
      grain: "1h",
      timezone: "Asia/Kolkata",
      calendar: noCalendar,
    });
    expect(result.buckets).toHaveLength(3);
    expect(result.buckets[0].partial).toBe(true);
  });

  it("deduplicates skipped-day calendar candidates and preserves 23/25-hour days", () => {
    const from = new Date("2026-03-28T23:00:00Z");
    const to = new Date("2026-03-31T22:00:00Z");
    const boundaries = normalizeCalendarBoundaries(
      [
        new Date("2026-03-28T23:00:00Z"),
        new Date("2026-03-29T22:00:00Z"),
        new Date("2026-03-29T22:00:00Z"),
        new Date("2026-03-30T22:00:00Z"),
      ],
      from,
      to,
    );
    expect(boundaries.map((value) => value.getTime())).toEqual([
      from.getTime(),
      new Date("2026-03-29T22:00:00Z").getTime(),
      new Date("2026-03-30T22:00:00Z").getTime(),
      to.getTime(),
    ]);
    expect(boundaries[1].getTime() - boundaries[0].getTime()).toBe(
      23 * 3600_000,
    );
  });

  it("rejects explicit selections above 400 and auto chooses at most 120", async () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-02-01T00:00:00Z");
    await expect(
      buildBuckets({
        from,
        to,
        asOf: to,
        grain: "1h",
        timezone: "UTC",
        calendar: noCalendar,
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    const automatic = await buildBuckets({
      from,
      to,
      asOf: to,
      grain: "auto",
      timezone: "UTC",
      calendar: async (start, end) => [start, end],
    });
    expect(automatic.buckets.length).toBeLessThanOrEqual(120);
    expect(automatic.resolvedGrain).toBe("12h");
  });

  it("keeps complete calendar buckets non-partial and suggests a fitting grain", async () => {
    const from = new Date("2026-01-05T00:00:00Z");
    const to = new Date("2026-01-12T00:00:00Z");
    const weekly = await buildBuckets({
      from,
      to,
      asOf: new Date("2026-01-20T00:00:00Z"),
      grain: "1w",
      timezone: "UTC",
      calendar: async () => [from, to],
    });
    expect(weekly.buckets).toEqual([
      { start: from, end: to, partial: false, current: false },
    ]);

    const longTo = new Date(from.getTime() + 401 * 3600_000);
    await expect(
      buildBuckets({
        from,
        to: longTo,
        asOf: longTo,
        grain: "1h",
        timezone: "UTC",
        calendar: async (start, end) => [start, end],
      }),
    ).rejects.toMatchObject({
      details: { suggested_grain: "6h" },
    });
  });
});
