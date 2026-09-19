import type { SearchMiddleware } from "@tanstack/react-router";
import type { ActivityCalendarResponse } from "@todou/shared";

/** Date selection only. The page supplies its approved timezone policy. */
export type ActivityDateSearch = {
  activity_year?: number;
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

export function parseActivityDateSearch(
  search: Record<string, unknown>,
): ActivityDateSearch {
  const rawYear = search.activity_year;
  const year =
    typeof rawYear === "number"
      ? rawYear
      : typeof rawYear === "string" && /^\d{1,4}$/.test(rawYear)
        ? Number(rawYear)
        : undefined;
  const validYear =
    year !== undefined && Number.isInteger(year) && year >= 1 && year <= 9998;
  const day =
    isActivityDate(search.activity_day) &&
    Number(search.activity_day.slice(0, 4)) >= 1 &&
    Number(search.activity_day.slice(0, 4)) <= 9998
      ? search.activity_day
      : undefined;
  const mismatch =
    validYear && day !== undefined && Number(day.slice(0, 4)) !== year;
  return {
    ...(validYear ? { activity_year: year } : {}),
    ...(day !== undefined && !mismatch ? { activity_day: day } : {}),
    ...((rawYear !== undefined && !validYear) ||
    (search.activity_day !== undefined && day === undefined) ||
    mismatch
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

export function resolveActivityDateSearch(
  search: ActivityDateSearch,
  context: { now: Date; timezone: string },
): { year: number; day?: string; invalid: boolean } {
  const parsed = parseActivityDateSearch(search);
  const today = activityToday(context.now, context.timezone);
  const currentYear = Number(today.slice(0, 4));
  const requestedYear =
    parsed.activity_year ??
    (parsed.activity_day
      ? Number(parsed.activity_day.slice(0, 4))
      : currentYear);
  const futureYear = requestedYear > currentYear;
  const year = futureYear ? currentYear : requestedYear;
  const day =
    !futureYear && parsed.activity_day && parsed.activity_day <= today
      ? parsed.activity_day
      : undefined;
  return {
    year,
    ...(day ? { day } : {}),
    invalid: Boolean(
      search.activity_invalid ||
        parsed.activity_invalid ||
        futureYear ||
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
