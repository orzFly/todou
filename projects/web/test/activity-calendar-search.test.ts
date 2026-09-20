import type { ActivityCalendarResponse } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityDateSearchParams,
  activityToday,
  browserActivityTimezone,
  defaultActivityDay,
  isActivityDate,
  parseActivityDateSearch,
  resolveActivityDateSearch,
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
