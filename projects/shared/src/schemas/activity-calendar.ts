import { z } from "zod";

import { Id, Timestamp } from "./common.ts";
import { Project, Status } from "./project.ts";

const CalendarYear = z.number().int().min(1).max(9998);
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

// Database timezone recognition, cutoff and subject/project birth boundaries
// are checked by the server against the current request's evidence scope.
export const ActivityCalendarQuery = z
  .strictObject({
    year: QueryNumber.pipe(CalendarYear),
    tz: Timezone,
    day: CalendarDate.optional(),
    limit: QueryNumber.pipe(z.number().int().min(1).max(100)).default(50),
    after: CalendarCursor.optional(),
  })
  .superRefine((query, ctx) => {
    if (
      query.day !== undefined &&
      Number(query.day.slice(0, 4)) !== query.year
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["day"],
        message: "day must belong to year",
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

export const ActivityDay = z.discriminatedUnion("state", [
  z.object({
    date: CalendarDate,
    state: z.literal("recorded"),
    count: NonNegativeSafeInteger,
  }),
  z.object({
    date: CalendarDate,
    state: z.literal("future"),
    count: z.null(),
  }),
  z.object({
    date: CalendarDate,
    state: z.literal("not_applicable"),
    count: z.null(),
  }),
]);
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
  year: CalendarYear,
  timezone: Timezone,
  cutoff: Timestamp,
  read_started_at: Timestamp,
  read_finished_at: Timestamp,
  days: z.array(ActivityDay),
  selection: ActivitySelection.nullable(),
});
export type ActivityCalendarResponse = z.infer<typeof ActivityCalendarResponse>;
