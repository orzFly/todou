import { BurnQuery, Grain, type Grain as InsightsGrain } from "@todou/shared";
import {
  type ActivityDateSearch,
  parseActivityDateSearch,
} from "@/lib/activity-calendar-search.ts";

export const INSIGHTS_PRESETS = ["24h", "7d", "30d", "90d"] as const;
export type InsightsPreset = (typeof INSIGHTS_PRESETS)[number];
export type InsightsRange = InsightsPreset | "custom";

export type InsightsSearch = ActivityDateSearch & {
  range?: InsightsRange;
  from?: string;
  /** Inclusive calendar date in the URL; requests use the following day. */
  to?: string;
  grain?: InsightsGrain;
  /** One or more recognized URL fields were present but invalid. */
  invalid?: true;
};

export type ResolvedInsightsSearch = {
  range: InsightsRange;
  from?: string;
  to?: string;
  grain: InsightsGrain;
  tz: string;
  invalid?: true;
};

export type InsightsSearchContext = {
  /** Injected to keep resolution deterministic and independent of the browser. */
  now: Date;
  /** The browser's preferred timezone, supplied by the caller, not read here. */
  timezone: string;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Calendar arithmetic only: these UTC dates never stand for IANA midnights. */
export function shiftCalendarDate(date: string, days: number): string {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

export function parseInsightsSearch(
  search: Record<string, unknown>,
): InsightsSearch {
  const range = [...INSIGHTS_PRESETS, "custom" as const].find(
    (value) => value === search.range,
  );
  const grain = Grain.safeParse(search.grain);
  const from = isCalendarDate(search.from) ? search.from : undefined;
  const to = isCalendarDate(search.to) ? search.to : undefined;
  const invalid =
    (search.range !== undefined && range === undefined) ||
    (search.from !== undefined && from === undefined) ||
    (search.to !== undefined && to === undefined) ||
    (search.grain !== undefined && !grain.success);
  return {
    range,
    from,
    to,
    grain: grain.success ? grain.data : undefined,
    ...(invalid ? { invalid: true as const } : {}),
    ...parseActivityDateSearch(search),
  };
}

export function resolveInsightsSearch(
  search: InsightsSearch,
  context: InsightsSearchContext,
): ResolvedInsightsSearch {
  // Validate here too: callers may construct search state without the router.
  const parsed = parseInsightsSearch(search);
  return {
    range: parsed.range ?? "30d",
    from: parsed.from,
    to: parsed.to,
    grain: parsed.grain ?? "auto",
    tz: isTimezone(context.timezone) ? context.timezone : "UTC",
    ...(parsed.invalid ? { invalid: true as const } : {}),
  };
}

export function insightsPresetRequest(
  preset: InsightsPreset,
  grain: InsightsGrain,
  tz: string,
  now: Date,
): BurnQuery {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError("Invalid current time");
  if (preset === "24h") {
    return BurnQuery.parse({
      from: new Date(now.getTime() - DAY_MS).toISOString(),
      to: now.toISOString(),
      grain,
      tz,
    });
  }

  // Intl is used only to find today's date in the browser timezone. The
  // server, not the browser, converts the date boundaries into instants.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const today = `${year}-${month}-${day}`;
  const days = { "7d": 7, "30d": 30, "90d": 90 }[preset];
  return BurnQuery.parse({
    from: shiftCalendarDate(today, 1 - days),
    to: shiftCalendarDate(today, 1),
    grain,
    tz,
  });
}

/** null means an incomplete, reversed, or oversized custom range; do not fetch. */
export function insightsRequest(
  search: InsightsSearch,
  context: InsightsSearchContext,
): BurnQuery | null {
  const resolved = resolveInsightsSearch(search, context);
  if (resolved.range !== "custom") {
    return insightsPresetRequest(
      resolved.range,
      resolved.grain,
      resolved.tz,
      context.now,
    );
  }
  if (resolved.from === undefined || resolved.to === undefined) return null;
  const exclusiveTo = shiftCalendarDate(resolved.to, 1);
  const result = BurnQuery.safeParse({
    from: resolved.from,
    to: exclusiveTo,
    grain: resolved.grain,
    tz: resolved.tz,
  });
  return result.success ? result.data : null;
}
