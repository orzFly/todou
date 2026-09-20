import type { SearchMiddleware } from "@tanstack/react-router";
import type { ActivityCalendarResponse } from "@todou/shared";

/** Date selection only. The page supplies its approved timezone policy. */
export type ActivityDateSearch = {
  activity_day?: string;
  /** Derived validation state. Never accepted from or written to a URL. */
  activity_invalid?: true;
};

export function isActivityDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length !== 10 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number(value.slice(0, 4)) < 1
  ) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

// A rolling window has no year to navigate to, so `activity_year` from an
// older link is dropped the same way a legacy `tz` is: silently, because a
// parameter this page no longer honours is not the reader's mistake.
export function parseActivityDateSearch(
  search: Record<string, unknown>,
): ActivityDateSearch {
  const day =
    isActivityDate(search.activity_day) &&
    Number(search.activity_day.slice(0, 4)) >= 1 &&
    Number(search.activity_day.slice(0, 4)) <= 9998
      ? search.activity_day
      : undefined;
  return {
    ...(day !== undefined ? { activity_day: day } : {}),
    ...(search.activity_day !== undefined && day === undefined
      ? { activity_invalid: true as const }
      : {}),
  };
}

/** Strip validation metadata at every URL serialization boundary. */
export function activityDateSearchParams<T extends ActivityDateSearch>(
  search: T,
): Omit<T, "activity_invalid"> {
  const { activity_invalid: _invalid, ...params } = search;
  return params;
}

// TanStack merges validator output into raw search and validates Link targets
// again. Strip after next() so neither inherited nor newly derived flags leak.
export const activityDateSearchMiddleware: SearchMiddleware<
  ActivityDateSearch
> = ({ search, next }) => activityDateSearchParams(next(search));

/** Calendar pages use the browser's IANA zone, with UTC when unavailable. */
export function browserActivityTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return "UTC";
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
}

/** Use Gregorian parts, independent of the user's locale calendar/numbering. */
export function activityToday(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year!.padStart(4, "0")}-${values.month}-${values.day}`;
}

const DAY_MS = 86_400_000;

function dayIndex(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function dayAt(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

// Day 0 (1970-01-01) was a Thursday, so +3 rotates the remainder onto Monday.
function mondayOnOrBefore(index: number): number {
  return index - ((index + 3) % 7);
}

/**
 * `weeks` whole columns whose last one holds `endExclusive - 1`. Aligning the
 * left edge to a Monday is what keeps every column a full week; the right edge
 * stays wherever the caller put it, so the newest column may be a partial one.
 */
function windowEndingAt(
  endExclusive: number,
  weeks: number,
): { from: string; to: string } {
  const monday = mondayOnOrBefore(endExclusive - 1);
  return {
    from: dayAt(monday - (weeks - 1) * 7),
    to: dayAt(endExclusive),
  };
}

/**
 * The default window: 52 columns ending with the current, unfinished week. It
 * stops at `today` rather than at the week's end because a future date has no
 * activity to show, and an empty cell there reads as a quiet day.
 */
export function rollingActivityWindow(
  today: string,
  weeks = 52,
): { from: string; to: string } {
  return windowEndingAt(dayIndex(today) + 1, weeks);
}

/**
 * A custom range uses the calendar as its picker, so the window frames that
 * range rather than the present: centred on it, never extending past `today`,
 * and anchored to the range's end once the range outgrows the window.
 */
export function centredActivityWindow(
  rangeFrom: string,
  rangeTo: string,
  today: string,
  weeks = 52,
): { from: string; to: string } {
  const span = weeks * 7;
  const start = dayIndex(rangeFrom);
  const end = dayIndex(rangeTo);
  const desired =
    end - start >= span
      ? end
      : Math.ceil((start + end) / 2) + Math.floor(span / 2);
  return windowEndingAt(Math.min(desired, dayIndex(today) + 1), weeks);
}

export function resolveActivityDateSearch(
  search: ActivityDateSearch,
  context: { now: Date; timezone: string },
): { day?: string; invalid: boolean } {
  const parsed = parseActivityDateSearch(search);
  const today = activityToday(context.now, context.timezone);
  const day =
    parsed.activity_day && parsed.activity_day <= today
      ? parsed.activity_day
      : undefined;
  return {
    ...(day ? { day } : {}),
    invalid: Boolean(
      search.activity_invalid ||
        parsed.activity_invalid ||
        (parsed.activity_day && parsed.activity_day > today),
    ),
  };
}

/** Birth/skipped-day validity comes from the server, never a guessed default. */
export function defaultActivityDay(
  response: ActivityCalendarResponse,
  requestedDay?: string,
): string | undefined {
  if (
    requestedDay &&
    response.days.some(
      (day) => day.date === requestedDay && day.state === "recorded",
    )
  ) {
    return requestedDay;
  }
  return response.days.findLast((day) => day.state === "recorded")?.date;
}
