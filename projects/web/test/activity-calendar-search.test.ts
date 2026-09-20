import type { ActivityCalendarResponse } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityDateSearchParams,
  activityToday,
  browserActivityTimezone,
  centredActivityWindow,
  defaultActivityDay,
  isActivityDate,
  parseActivityDateSearch,
  resolveActivityDateSearch,
  rollingActivityWindow,
} from "../src/lib/activity-calendar-search.ts";

const context = {
  now: new Date("2026-01-01T01:00:00Z"),
  timezone: "America/Los_Angeles",
};

afterEach(() => vi.restoreAllMocks());

describe("activity date search", () => {
  it("accepts actual Gregorian dates including early years and leap years", () => {
    for (const date of [
      "0001-01-01",
      "0099-12-31",
      "2000-02-29",
      "2024-02-29",
    ]) {
      expect(isActivityDate(date), date).toBe(true);
    }
    for (const date of [
      "0000-01-01",
      "1900-02-29",
      "2026-02-29",
      "2026-04-31",
      "2026-00-01",
      "2026-01-00",
      "2026-01-01\n",
      ["2026-01-01"],
      true,
      20260101,
    ]) {
      expect(
        parseActivityDateSearch({ activity_day: date }).activity_invalid,
        String(date),
      ).toBe(true);
    }
  });

  it("drops a legacy activity_year of any shape without calling it invalid", () => {
    for (const year of [
      true,
      [],
      [2026],
      {},
      0,
      2026,
      9999,
      "2e3",
      "2026x",
      2026.5,
    ]) {
      expect(parseActivityDateSearch({ activity_year: year })).toEqual({});
    }
    expect(
      parseActivityDateSearch({
        activity_day: "2024-02-29",
      }),
    ).toEqual({ activity_day: "2024-02-29" });
    // Any real date now stands on its own: there is no year for it to disagree with.
    expect(
      parseActivityDateSearch({
        activity_year: 2024,
        activity_day: "2023-02-28",
      }),
    ).toEqual({ activity_day: "2023-02-28" });
    expect(
      parseActivityDateSearch({
        activity_day: "2023-02-29",
      }),
    ).toEqual({ activity_invalid: true });
  });

  it("derives invalidity from dates and rejects every supplied marker", () => {
    const parsed = parseActivityDateSearch({
      activity_day: "2024-02-30",
    });
    expect(parsed).toEqual({ activity_invalid: true });
    expect(resolveActivityDateSearch(parsed, context)).toEqual({
      invalid: true,
    });
    expect(activityDateSearchParams(parsed)).toEqual({});
    expect(parseActivityDateSearch(parsed)).toEqual({});
    for (const marker of [true, "true", 1, [], {}, false, null]) {
      expect(parseActivityDateSearch({ activity_invalid: marker })).toEqual({});
    }
    expect(
      parseActivityDateSearch({
        ...parsed,
        activity_day: "2024-02-29",
      }),
    ).toEqual({ activity_day: "2024-02-29" });
  });

  it("leaves unrelated page filters outside its result", () => {
    expect(
      parseActivityDateSearch({
        role: "author",
        state: "all",
        range: "90d",
        grain: "1w",
        activity_day: "2024-02-29",
      }),
    ).toEqual({ activity_day: "2024-02-29" });
  });

  it("derives the current date in the supplied browser context", () => {
    expect(activityToday(context.now, context.timezone)).toBe("2025-12-31");
    expect(activityToday(context.now, "Asia/Tokyo")).toBe("2026-01-01");
    expect(resolveActivityDateSearch({}, context)).toEqual({ invalid: false });
    // A day older than the rolling window is still a legal request: the
    // window belongs to the page, and the server decides what is recorded.
    expect(
      resolveActivityDateSearch({ activity_day: "2024-02-29" }, context),
    ).toEqual({ day: "2024-02-29", invalid: false });
    expect(
      resolveActivityDateSearch({ activity_day: "2026-01-01" }, context),
    ).toEqual({ invalid: true });
    expect(
      resolveActivityDateSearch({ activity_day: "2025-12-31" }, context),
    ).toEqual({ day: "2025-12-31", invalid: false });
  });

  it("chooses only a recorded server date, including zero-count dates", () => {
    const response: ActivityCalendarResponse = {
      from: "2011-01-01",
      to: "2012-01-01",
      timezone: "Pacific/Apia",
      cutoff: "2012-01-01T00:00:00Z",
      read_started_at: "2012-01-01T00:00:00Z",
      read_finished_at: "2012-01-01T00:00:01Z",
      selection: null,
      days: [
        { date: "2011-12-28", state: "not_applicable", count: null },
        { date: "2011-12-29", state: "recorded", count: 3 },
        { date: "2011-12-30", state: "not_applicable", count: null },
        { date: "2011-12-31", state: "recorded", count: 0 },
      ],
    };
    expect(defaultActivityDay(response)).toBe("2011-12-31");
    expect(defaultActivityDay(response, "2011-12-29")).toBe("2011-12-29");
    expect(defaultActivityDay(response, "2011-12-30")).toBe("2011-12-31");
    expect(
      defaultActivityDay({
        ...response,
        days: [{ date: "2011-12-30", state: "not_applicable", count: null }],
      }),
    ).toBeUndefined();
    expect(
      defaultActivityDay({
        ...response,
        days: [{ date: "2011-12-31", state: "future", count: null }],
      }),
    ).toBeUndefined();
  });
});

describe("browser activity timezone", () => {
  it.each(["UTC", "Asia/Tokyo", "America/Los_Angeles"])(
    "uses the browser IANA timezone %s",
    (timeZone) => {
      const options = Intl.DateTimeFormat().resolvedOptions();
      vi.spyOn(
        Intl.DateTimeFormat.prototype,
        "resolvedOptions",
      ).mockReturnValue({
        ...options,
        timeZone,
      });
      expect(browserActivityTimezone()).toBe(timeZone);
    },
  );

  it.each(["", "Not/AZone"])(
    "falls back from an unavailable zone %j",
    (timeZone) => {
      const options = Intl.DateTimeFormat().resolvedOptions();
      vi.spyOn(
        Intl.DateTimeFormat.prototype,
        "resolvedOptions",
      ).mockReturnValue({
        ...options,
        timeZone,
      });
      expect(browserActivityTimezone()).toBe("UTC");
    },
  );

  it("falls back to UTC when reading the browser zone throws", () => {
    vi.spyOn(
      Intl.DateTimeFormat.prototype,
      "resolvedOptions",
    ).mockImplementation(() => {
      throw new Error("browser timezone unavailable");
    });
    expect(browserActivityTimezone()).toBe("UTC");
  });
});

// Weekday and span oracles are spelled out here rather than recomputed from the
// helper's own arithmetic, which is what lets them catch a shifted left edge.
const WEEKDAYS = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
function weekdayOf(date: string): string {
  const index = Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return WEEKDAYS[((index % 7) + 7) % 7] as string;
}
function spanOf(window: { from: string; to: string }): number {
  return (
    (Date.parse(`${window.to}T00:00:00Z`) -
      Date.parse(`${window.from}T00:00:00Z`)) /
    86_400_000
  );
}

describe("activity calendar windows", () => {
  it.each([
    ["2026-09-20", "2025-09-22", "2026-09-21", 364],
    ["2026-09-19", "2025-09-22", "2026-09-20", 363],
    ["2026-09-14", "2025-09-22", "2026-09-15", 358],
    ["2026-01-01", "2025-01-06", "2026-01-02", 361],
  ])(
    "ends the rolling window the day after %s, over 52 Monday columns",
    (today, from, to, span) => {
      const window = rollingActivityWindow(today);
      expect(window).toEqual({ from, to });
      expect(weekdayOf(from)).toBe("Mon");
      expect(spanOf(window)).toBe(span);
      // 52 columns whose last one is partial, and never past the server's cap.
      expect(Math.ceil(span / 7)).toBe(52);
      expect(span).toBeLessThanOrEqual(366);
    },
  );

  it("centres a short custom range, then caps it at today", () => {
    // A range wholly in the past centres: the window reaches past its end.
    const past = centredActivityWindow(
      "2026-03-01",
      "2026-03-31",
      "2026-09-20",
    );
    expect(past).toEqual({ from: "2025-09-15", to: "2026-09-14" });
    expect(weekdayOf(past.from)).toBe("Mon");
    // Centring would run past today here, so the cap wins and it matches the
    // rolling window: no future cell, whichever rule produced the edge.
    expect(
      centredActivityWindow("2026-09-01", "2026-09-15", "2026-09-20"),
    ).toEqual(rollingActivityWindow("2026-09-20"));
  });

  it("anchors a range wider than the window to its own end", () => {
    const wide = centredActivityWindow(
      "2024-01-01",
      "2026-01-01",
      "2026-09-20",
    );
    expect(wide).toEqual({ from: "2025-01-06", to: "2026-01-01" });
    expect(weekdayOf(wide.from)).toBe("Mon");
    expect(Math.ceil(spanOf(wide) / 7)).toBe(52);
  });

  it("keeps 52 columns for a range before the epoch", () => {
    // Day indices go negative there, and a plain `%` would return a negative
    // remainder and shift the left edge a week late, costing a column.
    const window = centredActivityWindow(
      "1960-01-01",
      "1960-01-11",
      "2026-09-20",
    );
    expect(window).toEqual({ from: "1959-07-13", to: "1960-07-06" });
    expect(weekdayOf(window.from)).toBe("Mon");
    expect(Math.ceil(spanOf(window) / 7)).toBe(52);
  });
});
