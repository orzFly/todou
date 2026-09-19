import type { ActivityDay } from "@todou/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/driver.ts";
import { ValidationFailedError } from "../../errors.ts";
import {
  localDateBoundarySql,
  rowsFrom,
  validatedTimezone,
} from "../calendar.ts";

export type ActivityBucket = {
  date: string;
  start: string;
  end: string;
  state: ActivityDay["state"];
};

export type ActivityBucketPlan = {
  timezone: string;
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  buckets: ActivityBucket[];
  days: ActivityDay[];
};

/** No Date arithmetic: skipped local dates stay present as nonselectable cells. */
export async function buildActivityBuckets(
  db: Db,
  input: {
    year: number;
    timezone: string;
    cutoff: string;
    bornAt: string;
    day?: string;
  },
): Promise<ActivityBucketPlan> {
  const timezone = await validatedTimezone(
    db,
    input.timezone,
    (message) => new ValidationFailedError(message),
  );
  const current = rowsFrom(
    await db.execute(sql`
    select extract(year from timezone(${timezone}, ${input.cutoff}::timestamptz))::integer as year
  `),
  );
  if (
    !Number.isInteger(input.year) ||
    input.year < 1 ||
    input.year > 9998 ||
    input.year > Number(current[0]?.year)
  ) {
    throw new ValidationFailedError(
      "year must be an existing calendar year at cutoff",
    );
  }
  const first = `${String(input.year).padStart(4, "0")}-01-01`;
  const next = `${String(input.year + 1).padStart(4, "0")}-01-01`;
  const rows = rowsFrom(
    await db.execute(sql`
    with dates as (
      select (${first}::date + n)::date as day
      from generate_series(0, (${next}::date - ${first}::date) - 1) as n
    ), boundaries as (
      select day,
        ${localDateBoundarySql(sql`day`, timezone, { earliest: true })} as start_at,
        ${localDateBoundarySql(sql`day + 1`, timezone, { earliest: true })} as end_at
      from dates
    )
    select to_char(day, 'YYYY-MM-DD') as date,
      to_char(start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        || case when extract(year from start_at at time zone 'UTC') < 0 then ' BC' else '' end as start,
      to_char(end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        || case when extract(year from end_at at time zone 'UTC') < 0 then ' BC' else '' end as end,
      case when end_at <= start_at
        or timezone(${timezone}, start_at)::date <> day
        or day < timezone(${timezone}, ${input.bornAt}::timestamptz)::date then 'not_applicable'
        when day > timezone(${timezone}, ${input.cutoff}::timestamptz)::date then 'future'
        else 'recorded' end as state
    from boundaries order by day
  `),
  );
  const buckets = rows.map((row): ActivityBucket => {
    if (
      typeof row.date !== "string" ||
      typeof row.start !== "string" ||
      typeof row.end !== "string" ||
      !["recorded", "future", "not_applicable"].includes(String(row.state))
    ) {
      throw new Error("database returned an invalid calendar boundary");
    }
    return {
      date: row.date,
      start: row.start,
      end: row.end,
      state: row.state as ActivityDay["state"],
    };
  });
  if (
    input.day !== undefined &&
    buckets.find((bucket) => bucket.date === input.day)?.state !== "recorded"
  ) {
    throw new ValidationFailedError(
      "day must be an applicable, non-future local date in year",
    );
  }
  const from = buckets[0]?.start;
  const to = buckets.at(-1)?.end;
  if (from === undefined || to === undefined)
    throw new Error("empty calendar year");
  return {
    timezone,
    from,
    to,
    fromDate: first,
    toDate: next,
    buckets,
    days: buckets.map(
      (bucket): ActivityDay =>
        bucket.state === "recorded"
          ? { date: bucket.date, state: "recorded", count: 0 }
          : { date: bucket.date, state: bucket.state, count: null },
    ),
  };
}
