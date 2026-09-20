import { z } from "zod";

import { Id, Timestamp } from "./common.ts";
import { Project, Status } from "./project.ts";

const Timezone = z.string().min(1).max(100);
const CalendarCursor = z.string().max(8192);
const NonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
// Restrict coercion to URL strings and numbers: Number(true) and Number([1])
// must not turn invalid input kinds into valid years or page sizes.
const QueryNumber = z.union([z.string(), z.number()]).pipe(z.coerce.number());

const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .length(10)
  .refine((date) => {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [
      31,
      leap ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    return year >= 1 && day >= 1 && day <= (monthDays[month - 1] ?? 0);
  }, "date must exist in the Gregorian calendar");

/** Days between `from` and `to`, at most a leap year's worth of cells. */
export const MAX_ACTIVITY_WINDOW_DAYS = 366;

function dayNumber(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
}

// Database timezone recognition, cutoff and subject/project birth boundaries
// are checked by the server against the current request's evidence scope.
// The window is a half-open local-date range: the caller owns which window it
// wants (a calendar year, a rolling 52 weeks, a custom span) and the server
// only renders the cells for it.
export const ActivityCalendarQuery = z
  .strictObject({
    from: CalendarDate,
    to: CalendarDate,
    tz: Timezone,
    day: CalendarDate.optional(),
    limit: QueryNumber.pipe(z.number().int().min(1).max(100)).default(50),
    after: CalendarCursor.optional(),
  })
  .superRefine((query, ctx) => {
    const span =
      (dayNumber(query.to) - dayNumber(query.from)) / (24 * 60 * 60 * 1000);
    if (span <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must be later than from",
      });
    } else if (span > MAX_ACTIVITY_WINDOW_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `the activity window cannot exceed ${MAX_ACTIVITY_WINDOW_DAYS} days`,
      });
    }
    if (
      query.day !== undefined &&
      (query.day < query.from || query.day >= query.to)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["day"],
        message: "day must fall inside the window",
      });
    }
    if (query.after !== undefined && query.day === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["after"],
        message: "after requires day",
      });
    }
  });
export type ActivityCalendarQuery = z.infer<typeof ActivityCalendarQuery>;
// Input keeps limit optional and permits URL numeric strings without widening
// the client API to an arbitrary query dictionary.
export type ActivityCalendarQueryInput = z.input<typeof ActivityCalendarQuery>;

// The instants a local date spans are the server's to state: it alone holds the
// IANA rules, and a cell that has to line up with a time axis cannot be placed
// by re-deriving midnight in the browser. `end` is the next date's `start`, so
// a civil date that was skipped outright spans nothing and the two are equal.
const DayBounds = {
  start: Timestamp,
  end: Timestamp,
};

export const ActivityDay = z
  .discriminatedUnion("state", [
    z.object({
      date: CalendarDate,
      state: z.literal("recorded"),
      count: NonNegativeSafeInteger,
      ...DayBounds,
    }),
    z.object({
      date: CalendarDate,
      state: z.literal("future"),
      count: z.null(),
      ...DayBounds,
    }),
    z.object({
      date: CalendarDate,
      state: z.literal("not_applicable"),
      count: z.null(),
      ...DayBounds,
    }),
  ])
  .refine((day) => Date.parse(day.end) >= Date.parse(day.start), {
    path: ["end"],
    message: "end must be at or after start",
  });
export type ActivityDay = z.infer<typeof ActivityDay>;

export const ActivityCard = z
  .object({
    project: Project.pick({ id: true, slug: true, name: true }).extend({
      issue_prefix: z.string().nullable(),
    }),
    issue_id: Id,
    number: Id,
    title: z.string(),
    status: Status,
    url: z.string(),
    last_active_at: Timestamp,
  })
  .refine(
    (card) => {
      // Valid ProjectSlug characters are unchanged by encoding. Reject controls
      // and malformed Unicode as validation failures, without throwing URIError.
      try {
        const slug = encodeURIComponent(card.project.slug);
        return (
          slug === card.project.slug &&
          card.url === `/projects/${slug}/issues/${card.number}`
        );
      } catch {
        return false;
      }
    },
    { path: ["url"], message: "url must be the canonical relative card path" },
  );
export type ActivityCard = z.infer<typeof ActivityCard>;

export const ActivitySelection = z
  .object({
    date: CalendarDate,
    total: NonNegativeSafeInteger,
    items: z.array(ActivityCard),
    next_cursor: CalendarCursor.nullable(),
    has_more: z.boolean(),
  })
  .refine(
    (selection) => selection.has_more === (selection.next_cursor !== null),
    {
      path: ["next_cursor"],
      message: "next_cursor must be non-null exactly when has_more is true",
    },
  );
export type ActivitySelection = z.infer<typeof ActivitySelection>;

// Calendar completeness/order, selection totals and page ordering are cross-row
// invariants asserted by the service tests over the same evidence snapshot.
export const ActivityCalendarResponse = z.object({
  from: CalendarDate,
  to: CalendarDate,
  timezone: Timezone,
  cutoff: Timestamp,
  read_started_at: Timestamp,
  read_finished_at: Timestamp,
  days: z.array(ActivityDay),
  selection: ActivitySelection.nullable(),
});
export type ActivityCalendarResponse = z.infer<typeof ActivityCalendarResponse>;
