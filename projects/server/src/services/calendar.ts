import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { DomainError } from "../errors.ts";
import type { BoundaryProvider } from "./insights/buckets.ts";

export type CalendarValidation = (message: string) => Error;
const burnValidation: CalendarValidation = (message) =>
  new DomainError(400, "validation_failed", message);

export function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = result.rows;
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }
  throw new Error("database returned an invalid row result");
}

export function dateValue(
  row: Record<string, unknown> | undefined,
  key: string,
): Date {
  const raw = row?.[key];
  const date = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(date.getTime()))
    throw new Error(`database returned invalid ${key}`);
  return date;
}

export async function validatedTimezone(
  db: Db,
  timezone: string,
  validation: CalendarValidation = burnValidation,
): Promise<string> {
  const result = rowsFrom(
    await db.execute(
      sql`select name from pg_timezone_names where name = ${timezone} limit 1`,
    ),
  );
  if (result.length === 0)
    throw validation(`unknown IANA timezone: ${timezone}`);
  return timezone;
}

/** Calendar dates become instants in PostgreSQL's IANA database. */
export function localDateBoundarySql(
  value: SQLWrapper,
  timezone: string,
  options: { earliest?: boolean } = {},
): SQL {
  const wall = sql`(${value})::date::timestamp`;
  const boundary = sql`(${wall} at time zone ${timezone})`;
  if (!options.earliest) return boundary;
  // PostgreSQL chooses the later occurrence of an ambiguous local midnight.
  // Activity needs the entire civil day. Probe the adjacent IANA offsets and
  // accept only instants that round-trip to this exact midnight; gaps retain
  // PostgreSQL's forward resolution, including a wholly skipped local date.
  return sql`coalesce((
    select min(candidate) from (
      select (${wall} - (
        timezone(${timezone}, sample) - timezone('UTC', sample)
      )) at time zone 'UTC' as candidate
      from (values
        (${boundary} - interval '24 hours'),
        (${boundary}),
        (${boundary} + interval '24 hours')
      ) as calendar_samples(sample)
    ) as calendar_candidates
    where timezone(${timezone}, candidate) = ${wall}
  ), ${boundary})`;
}

export async function localDateBoundary(
  db: Db,
  value: string,
  timezone: string,
): Promise<Date> {
  const rows = rowsFrom(
    await db.execute(
      sql`select ${localDateBoundarySql(sql`${value}`, timezone)} as boundary`,
    ),
  );
  return dateValue(rows[0], "boundary");
}

/** T-389's day/week provider; activity uses the same boundary expression. */
export function calendarProvider(db: Db): BoundaryProvider {
  return async (from, to, grain, timezone) => {
    const base = sql`
      select ${localDateBoundarySql(sql`d`, timezone)} as boundary
      from generate_series(
        (timezone(${timezone}, ${from.toISOString()}::timestamptz)::date - 8),
        (timezone(${timezone}, ${to.toISOString()}::timestamptz)::date + 8),
        interval '1 day'
      ) as d`;
    const result =
      grain === "1w"
        ? await db.execute(sql`${base} where extract(isodow from d) = 1`)
        : await db.execute(base);
    return rowsFrom(result).map((row) => dateValue(row, "boundary"));
  };
}
