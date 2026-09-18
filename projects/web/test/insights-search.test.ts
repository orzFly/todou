import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  insightsBurnQuery,
  insightsKeys,
  insightsSettingsQuery,
} from "../src/api/insights.ts";
import { api } from "../src/api/queries.ts";
import {
  INSIGHTS_PRESETS,
  insightsPresetRequest,
  insightsRequest,
  parseInsightsSearch,
  resolveInsightsSearch,
} from "../src/lib/insights-search.ts";

const context = {
  now: new Date("2026-03-08T07:30:00Z"),
  timezone: "America/New_York",
};

afterEach(() => vi.restoreAllMocks());

describe("insights search", () => {
  it("keeps only recognized, well-formed URL values", () => {
    expect(
      parseInsightsSearch({
        range: "custom",
        from: "2026-02-28",
        to: "2026-03-08",
        grain: "6h",
        tz: "America/New_York",
        other: "ignored",
      }),
    ).toEqual({
      range: "custom",
      from: "2026-02-28",
      to: "2026-03-08",
      grain: "6h",
      tz: "America/New_York",
    });
    expect(
      parseInsightsSearch({
        range: "365d",
        from: "2026-02-30",
        to: "2026-03-08T00:00:00Z",
        grain: "2h",
        tz: "Not/AZone",
      }),
    ).toEqual({
      range: undefined,
      from: undefined,
      to: undefined,
      grain: undefined,
      tz: undefined,
      invalid: true,
    });
    expect(
      parseInsightsSearch({ from: ["2026-03-08"], tz: 7 }).from,
    ).toBeUndefined();
  });

  it("resolves defaults and timezone fallback without reading browser state", () => {
    expect(resolveInsightsSearch({}, context)).toEqual({
      range: "30d",
      from: undefined,
      to: undefined,
      grain: "auto",
      tz: "America/New_York",
    });
    expect(
      resolveInsightsSearch({ tz: "Asia/Tokyo", grain: "1w" }, context),
    ).toMatchObject({ tz: "Asia/Tokyo", grain: "1w" });
    expect(
      resolveInsightsSearch({}, { ...context, timezone: "Not/AZone" }).tz,
    ).toBe("UTC");
  });

  it.each(["auto", "1h", "6h", "12h", "1d", "1w"])(
    "accepts the contracted grain %s",
    (grain) => expect(parseInsightsSearch({ grain }).grain).toBe(grain),
  );

  it("uses a rolling timestamp range for 24h, including across DST", () => {
    const request = insightsRequest({ range: "24h" }, context);
    expect(request).toEqual({
      from: "2026-03-07T07:30:00.000Z",
      to: "2026-03-08T07:30:00.000Z",
      grain: "auto",
      tz: "America/New_York",
    });
    expect(insightsRequest({ range: "24h" }, context)).toEqual(request);
  });

  it.each([
    ["7d", "2026-03-02"],
    ["30d", "2026-02-07"],
    ["90d", "2025-12-09"],
  ] as const)(
    "keeps %s calendar dates and an exclusive tomorrow",
    (range, from) => {
      expect(insightsRequest({ range }, context)).toEqual({
        from,
        to: "2026-03-09",
        grain: "auto",
        tz: "America/New_York",
      });
    },
  );

  it("finds today in the requested timezone, not the host timezone", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    expect(
      insightsPresetRequest("7d", "1d", "America/Los_Angeles", now),
    ).toEqual({
      from: "2025-12-25",
      to: "2026-01-01",
      grain: "1d",
      tz: "America/Los_Angeles",
    });
    expect(insightsPresetRequest("7d", "auto", "Asia/Tokyo", now).to).toBe(
      "2026-01-02",
    );
  });

  it.each([
    ["2024-02-29", "2024-03-01"],
    ["2026-03-08", "2026-03-09"],
    ["2026-11-01", "2026-11-02"],
    ["2026-12-31", "2027-01-01"],
  ])("converts inclusive custom end %s into date %s", (date, nextDay) => {
    expect(
      insightsRequest({ range: "custom", from: date, to: date }, context),
    ).toEqual({
      from: date,
      to: nextDay,
      grain: "auto",
      tz: "America/New_York",
    });
  });

  it("does not fetch invalid or incomplete custom ranges", () => {
    for (const search of [
      { range: "custom" as const },
      { range: "custom" as const, from: "2026-03-08" },
      { range: "custom" as const, from: "2026-03-08", to: "2026-03-07" },
      { range: "custom" as const, from: "2026-02-30", to: "2026-03-08" },
      { range: "custom" as const, from: "2024-01-01", to: "2025-01-01" },
    ]) {
      expect(insightsRequest(search, context)).toBeNull();
    }
    expect(
      insightsRequest(
        { range: "custom", from: "2024-01-01", to: "2024-12-31" },
        context,
      ),
    ).not.toBeNull();
  });

  it("exposes only the approved presets and rejects an invalid clock", () => {
    expect(INSIGHTS_PRESETS).toEqual(["24h", "7d", "30d", "90d"]);
    expect(() =>
      insightsPresetRequest("24h", "auto", "UTC", new Date(Number.NaN)),
    ).toThrow(RangeError);
  });
});

describe("insights query keys", () => {
  const request = {
    from: "2026-03-01",
    to: "2026-03-09",
    grain: "auto" as const,
    tz: "UTC",
  };

  it("separates project, both boundaries, grain, timezone, and settings version", () => {
    const keys = [
      insightsKeys.burnRequest("demo", request, "v1"),
      insightsKeys.burnRequest("other", request, "v1"),
      insightsKeys.burnRequest(
        "demo",
        { ...request, from: "2026-03-02" },
        "v1",
      ),
      insightsKeys.burnRequest("demo", { ...request, to: "2026-03-10" }, "v1"),
      insightsKeys.burnRequest("demo", { ...request, grain: "1d" }, "v1"),
      insightsKeys.burnRequest("demo", { ...request, tz: "Asia/Tokyo" }, "v1"),
      insightsKeys.burnRequest("demo", request, "v2"),
      insightsKeys.settings("demo"),
    ];
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(
      keys.length,
    );
    expect(insightsKeys.burnRequest("demo", { ...request }, "v1")).toEqual(
      keys[0],
    );
    expect(insightsSettingsQuery("demo").queryKey).toEqual([
      "insights-settings",
      "demo",
    ]);
  });

  it("snapshots the request for both its key and its fetch", async () => {
    const input = { ...request };
    const query = insightsBurnQuery("demo", input, "v1");
    const fetch = vi
      .spyOn(api, "getInsightsBurn")
      .mockRejectedValue(new Error("stub"));
    input.from = "2026-03-05";
    expect(query.queryKey).toEqual(
      insightsKeys.burnRequest("demo", request, "v1"),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    try {
      await expect(client.fetchQuery(query)).rejects.toThrow("stub");
      expect(fetch).toHaveBeenCalledWith("demo", request);
    } finally {
      client.clear();
    }
  });
});
