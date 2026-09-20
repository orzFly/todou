import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, type DbHandle, openDb } from "../src/db/driver.ts";
import { DomainError, ValidationFailedError } from "../src/errors.ts";
import { buildActivityBuckets } from "../src/services/activity-calendar/buckets.ts";
import {
  calendarProvider,
  localDateBoundary,
  validatedTimezone,
} from "../src/services/calendar.ts";

describe("activity calendar IANA buckets and shared burn date regressions", () => {
  let handle: DbHandle;
  let db: Db;
  beforeAll(async () => {
    handle = await openDb("pglite://memory/activity-calendar-buckets");
    db = handle.db;
  });
  afterAll(async () => handle.close());

  it("enumerates the complete leap year, preserving zero and null day states", async () => {
    const plan = await buildActivityBuckets(db, {
      fromDate: "2024-01-01",
      toDate: "2025-01-01",
      timezone: "UTC",
      bornAt: "2024-02-29T12:00:00.000001Z",
      cutoff: "2024-03-01T00:00:00.000000Z",
    });
    expect(plan.days).toHaveLength(366);
    expect(plan.days[0]).toEqual({
      date: "2024-01-01",
      state: "not_applicable",
      count: null,
    });
    expect(plan.days[58]).toEqual({
      date: "2024-02-28",
      state: "not_applicable",
      count: null,
    });
    expect(plan.days[59]).toEqual({
      date: "2024-02-29",
      state: "recorded",
      count: 0,
    });
    expect(plan.days[60]).toEqual({
      date: "2024-03-01",
      state: "recorded",
      count: 0,
    });
    expect(plan.days[61]).toEqual({
      date: "2024-03-02",
      state: "future",
      count: null,
    });
    expect(plan.days.at(-1)).toEqual({
      date: "2024-12-31",
      state: "future",
      count: null,
    });
    expect(new Set(plan.days.map((day) => day.date)).size).toBe(366);
    expect(plan.from).toBe("2024-01-01T00:00:00.000000Z");
    expect(plan.to).toBe("2025-01-01T00:00:00.000000Z");
  });

  it.each([
    [
      "America/New_York",
      "2026-03-08",
      "2026-03-08T05:00:00.000000Z",
      "2026-03-09T04:00:00.000000Z",
      23,
    ],
    [
      "America/New_York",
      "2026-11-01",
      "2026-11-01T04:00:00.000000Z",
      "2026-11-02T05:00:00.000000Z",
      25,
    ],
    [
      "Asia/Kolkata",
      "2026-09-18",
      "2026-09-17T18:30:00.000000Z",
      "2026-09-18T18:30:00.000000Z",
      24,
    ],
    [
      "Asia/Shanghai",
      "2026-09-18",
      "2026-09-17T16:00:00.000000Z",
      "2026-09-18T16:00:00.000000Z",
      24,
    ],
  ] as const)(
    "uses exact IANA boundaries for %s %s",
    async (timezone, day, start, end, hours) => {
      const plan = await buildActivityBuckets(db, {
        fromDate: "2026-01-01",
        toDate: "2027-01-01",
        timezone,
        bornAt: "2020-01-01T00:00:00Z",
        cutoff: "2026-12-31T23:59:59.999999Z",
        day,
      });
      const bucket = plan.buckets.find((bucket) => bucket.date === day);
      expect(bucket).toEqual({ date: day, start, end, state: "recorded" });
      expect((Date.parse(end) - Date.parse(start)) / 3600_000).toBe(hours);
    },
  );

  it("keeps Apia's skipped date visible and refuses selecting it", async () => {
    const input = {
      fromDate: "2011-01-01",
      toDate: "2012-01-01",
      timezone: "Pacific/Apia",
      bornAt: "2010-01-01T00:00:00Z",
      cutoff: "2012-01-02T00:00:00Z",
    };
    const plan = await buildActivityBuckets(db, input);
    expect(plan.days).toHaveLength(365);
    expect(plan.days.slice(-3)).toEqual([
      { date: "2011-12-29", state: "recorded", count: 0 },
      { date: "2011-12-30", state: "not_applicable", count: null },
      { date: "2011-12-31", state: "recorded", count: 0 },
    ]);
    expect(plan.buckets.find((bucket) => bucket.date === "2011-12-30")).toEqual(
      {
        date: "2011-12-30",
        state: "not_applicable",
        start: "2011-12-30T10:00:00.000000Z",
        end: "2011-12-30T10:00:00.000000Z",
      },
    );
    await expect(
      buildActivityBuckets(db, { ...input, day: "2011-12-30" }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("classifies birth before future, and preserves birth microseconds", async () => {
    const plan = await buildActivityBuckets(db, {
      fromDate: "2026-01-01",
      toDate: "2027-01-01",
      timezone: "UTC",
      bornAt: "2026-09-19T00:00:00.000001Z",
      cutoff: "2026-09-18T12:00:00Z",
    });
    expect(plan.days.find((day) => day.date === "2026-09-18")).toEqual({
      date: "2026-09-18",
      state: "not_applicable",
      count: null,
    });
    expect(plan.days.find((day) => day.date === "2026-09-19")).toEqual({
      date: "2026-09-19",
      state: "future",
      count: null,
    });
    const beforeMidnight = await buildActivityBuckets(db, {
      fromDate: "2026-01-01",
      toDate: "2027-01-01",
      timezone: "UTC",
      bornAt: "2026-09-18T23:59:59.999999Z",
      cutoff: "2026-09-19T00:00:00Z",
    });
    expect(
      beforeMidnight.days.find((day) => day.date === "2026-09-18"),
    ).toEqual({
      date: "2026-09-18",
      state: "recorded",
      count: 0,
    });
    const atMidnight = await buildActivityBuckets(db, {
      fromDate: "2026-01-01",
      toDate: "2027-01-01",
      timezone: "UTC",
      bornAt: "2026-09-19T00:00:00.000000Z",
      cutoff: "2026-09-19T00:00:00Z",
    });
    expect(
      atMidnight.days.find((day) => day.date === "2026-09-18")?.state,
    ).toBe("not_applicable");
  });

  it("supports year one, and rejects bad windows and inapplicable selections", async () => {
    const input = {
      fromDate: "2026-01-01",
      toDate: "2027-01-01",
      timezone: "Asia/Shanghai",
      bornAt: "2025-12-31T16:00:00Z",
      cutoff: "2025-12-31T16:00:00Z",
    };
    const plan = await buildActivityBuckets(db, {
      ...input,
      day: "2026-01-01",
    });
    expect(plan.days[0]).toEqual({
      date: "2026-01-01",
      state: "recorded",
      count: 0,
    });
    for (const override of [
      // 2026 has 365 days, so this is 367: one past the widest window allowed,
      // followed by a reversed window and an empty one.
      { toDate: "2027-01-03" },
      { toDate: "2025-01-01" },
      { toDate: "2026-01-01", fromDate: "2026-01-01" },
      { day: "2026-01-02" },
      { day: "2025-12-31" },
    ]) {
      await expect(
        buildActivityBuckets(db, { ...input, ...override }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    }
    const ancient = await buildActivityBuckets(db, {
      fromDate: "0001-01-01",
      toDate: "0002-01-01",
      timezone: "UTC",
      bornAt: "2020-01-01T00:00:00Z",
      cutoff: "2026-01-01T00:00:00Z",
    });
    expect(ancient.days).toHaveLength(365);
    expect(ancient.from).toBe("0001-01-01T00:00:00.000000Z");
    expect(ancient.to).toBe("0002-01-01T00:00:00.000000Z");
    expect(
      ancient.days.every(
        (day) => day.state === "not_applicable" && day.count === null,
      ),
    ).toBe(true);
  });

  it("keeps year-one east-of-UTC boundaries native instead of losing the BC era", async () => {
    const plan = await buildActivityBuckets(db, {
      fromDate: "0001-01-01",
      toDate: "0002-01-01",
      timezone: "Etc/GMT-8",
      bornAt: "0001-01-01T00:00:00Z",
      cutoff: "0002-01-01T00:00:00Z",
    });
    expect(plan.fromDate).toBe("0001-01-01");
    expect(plan.toDate).toBe("0002-01-01");
    expect(plan.from).toBe("0001-12-31T16:00:00.000000Z BC");
    expect(plan.to).toBe("0001-12-31T16:00:00.000000Z");
    expect(plan.days[0]).toEqual({
      date: "0001-01-01",
      state: "recorded",
      count: 0,
    });
  });

  it("uses the first Havana midnight and local birth date while preserving burn's boundary contract", async () => {
    const plan = await buildActivityBuckets(db, {
      fromDate: "2025-01-01",
      toDate: "2026-01-01",
      timezone: "America/Havana",
      bornAt: "2025-11-02T04:30:00.000000Z",
      cutoff: "2025-11-03T12:00:00.000000Z",
    });
    expect(plan.buckets.find((bucket) => bucket.date === "2025-11-02")).toEqual(
      {
        date: "2025-11-02",
        start: "2025-11-02T04:00:00.000000Z",
        end: "2025-11-03T05:00:00.000000Z",
        state: "recorded",
      },
    );
    expect(plan.days.find((day) => day.date === "2025-11-01")).toEqual({
      date: "2025-11-01",
      state: "not_applicable",
      count: null,
    });
    await expect(
      buildActivityBuckets(db, {
        fromDate: "2025-01-01",
        toDate: "2026-01-01",
        timezone: "America/Havana",
        bornAt: "2025-11-02T04:30:00.000000Z",
        cutoff: "2025-11-03T12:00:00.000000Z",
        day: "2025-11-01",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      (
        await localDateBoundary(db, "2025-11-02", "America/Havana")
      ).toISOString(),
    ).toBe("2025-11-02T05:00:00.000Z");
  });

  it("keeps burn timezone errors at 400 and activity errors at 422 with safe parameter binding", async () => {
    for (const timezone of ["Unknown/Zone", "UTC'); select 1; --"]) {
      await expect(validatedTimezone(db, timezone)).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
      });
      await expect(
        buildActivityBuckets(db, {
          fromDate: "2026-01-01",
          toDate: "2027-01-01",
          timezone,
          bornAt: "2020-01-01T00:00:00Z",
          cutoff: "2026-09-19T00:00:00Z",
        }),
      ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    }
    expect(await validatedTimezone(db, "UTC")).toBe("UTC");
  });

  it("preserves burn local date and ISO-week boundaries across both DST transitions", async () => {
    expect(
      (
        await localDateBoundary(db, "2026-03-08", "America/New_York")
      ).toISOString(),
    ).toBe("2026-03-08T05:00:00.000Z");
    expect(
      (
        await localDateBoundary(db, "2026-03-09", "America/New_York")
      ).toISOString(),
    ).toBe("2026-03-09T04:00:00.000Z");
    expect(
      (
        await localDateBoundary(db, "2026-11-01", "America/New_York")
      ).toISOString(),
    ).toBe("2026-11-01T04:00:00.000Z");
    expect(
      (
        await localDateBoundary(db, "2026-11-02", "America/New_York")
      ).toISOString(),
    ).toBe("2026-11-02T05:00:00.000Z");
    const provider = calendarProvider(db);
    const weekly = await provider(
      new Date("2026-03-08T05:00:00Z"),
      new Date("2026-03-10T04:00:00Z"),
      "1w",
      "America/New_York",
    );
    expect(weekly.map((at) => at.toISOString())).toEqual([
      "2026-03-02T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
      "2026-03-16T04:00:00.000Z",
    ]);
    const daily = await provider(
      new Date("2026-03-08T05:00:00Z"),
      new Date("2026-03-09T04:00:00Z"),
      "1d",
      "America/New_York",
    );
    expect(daily.map((at) => at.toISOString())).toContain(
      "2026-03-08T05:00:00.000Z",
    );
    expect(daily.map((at) => at.toISOString())).toContain(
      "2026-03-09T04:00:00.000Z",
    );
  });

  it("propagates real database failures instead of converting them into validation or zero buckets", async () => {
    const failure = new Error("calendar database unavailable");
    const spy = vi.spyOn(db, "execute").mockRejectedValueOnce(failure);
    try {
      await expect(
        buildActivityBuckets(db, {
          fromDate: "2026-01-01",
          toDate: "2027-01-01",
          timezone: "UTC",
          bornAt: "2020-01-01T00:00:00Z",
          cutoff: "2026-09-19T00:00:00Z",
        }),
      ).rejects.toBe(failure);
      expect(failure).not.toBeInstanceOf(DomainError);
    } finally {
      spy.mockRestore();
    }
  });
});
