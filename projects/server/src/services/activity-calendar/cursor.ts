import { createHash } from "node:crypto";
import { z } from "zod";
import { ConflictError, ValidationFailedError } from "../../errors.ts";

export const ACTIVITY_CALENDAR_CURSOR_MAX_LENGTH = 8192;

const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function isGregorianDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
  );
}

const CalendarDate = z
  .string()
  .length(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isGregorianDate);
const MicroTimestamp = z
  .string()
  .length(27)
  .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/)
  .refine((value) => isGregorianDate(value.slice(0, 10)));
const Scope = z.strictObject({ type: z.enum(["project", "user"]), id: Id });
const Binding = z
  .strictObject({
    viewer_id: Id,
    scope: Scope,
    year: z.number().int().min(1).max(9998),
    day: CalendarDate,
    tz: z.string().min(1).max(100),
    limit: z.number().int().min(1).max(100),
  })
  .refine((value) => Number(value.day.slice(0, 4)) === value.year);
const Hashes = z.strictObject({
  scope_hash: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/),
  set_hash: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/),
});
const Position = z.strictObject({
  at: MicroTimestamp,
  project_id: Id,
  issue_id: Id,
});
const Envelope = z
  .strictObject({
    v: z.literal(1),
    kind: z.literal("activity-calendar"),
    ...Binding.shape,
    ...Hashes.shape,
    last: Position,
  })
  .refine((value) => Number(value.day.slice(0, 4)) === value.year);

/** The caller validates tz against the database and day against cutoff/birth. */
export type ActivityCalendarCursorBinding = z.infer<typeof Binding>;
export type ActivityCalendarCursorHashes = z.infer<typeof Hashes>;
export type ActivityCalendarPosition = z.infer<typeof Position>;
export type ActivityCalendarCursor = z.infer<typeof Envelope>;

/** One already aggregated card/day, with a canonical six-fraction-digit UTC timestamp. */
export type ActivityCalendarCursorRow = {
  project_id: number;
  issue_id: number;
  last_active_at: string;
};

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationFailedError("malformed activity calendar cursor");
  }
  return result.data;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

/** SHA-256 of UTF-8 JSON.stringify(sorted unique numeric project IDs), without whitespace. */
export function activityCalendarScopeHash(
  projectIds: readonly number[],
): string {
  const ids = projectIds.map((id) => checked(Id, id));
  return digest([...new Set(ids)].sort((a, b) => a - b));
}

function positionOf(row: ActivityCalendarCursorRow): ActivityCalendarPosition {
  return checked(Position, {
    at: row.last_active_at,
    project_id: row.project_id,
    issue_id: row.issue_id,
  });
}

/**
 * SHA-256 of UTF-8 JSON.stringify([[project_id, issue_id, last_active_at], ...]),
 * without whitespace, sorted by numeric project_id then issue_id ascending.
 * Input must contain exactly one row per permanent identity. Presentation fields
 * (slug, issue number, title, status) do not participate in this digest.
 */
export function activityCalendarSetHash(
  rows: readonly ActivityCalendarCursorRow[],
): string {
  const positions = rows
    .map(positionOf)
    .sort((a, b) => a.project_id - b.project_id || a.issue_id - b.issue_id);
  for (let i = 1; i < positions.length; i++) {
    const previous = positions[i - 1]!;
    const current = positions[i]!;
    if (
      previous.project_id === current.project_id &&
      previous.issue_id === current.issue_id
    ) {
      throw new ValidationFailedError("duplicate activity calendar identity");
    }
  }
  return digest(positions.map((row) => [row.project_id, row.issue_id, row.at]));
}

/** Ordering for Array.sort: timestamp descending, project and issue IDs ascending. */
export function compareActivityCalendarPositions(
  a: ActivityCalendarPosition,
  b: ActivityCalendarPosition,
): number {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1;
  return a.project_id - b.project_id || a.issue_id - b.issue_id;
}

/** Strict keyset predicate; equality never delivers the boundary row again. */
export function isAfterActivityCalendarPosition(
  position: ActivityCalendarPosition,
  last: ActivityCalendarPosition,
): boolean {
  return compareActivityCalendarPositions(position, last) > 0;
}

export function encodeActivityCalendarCursor(
  binding: ActivityCalendarCursorBinding,
  hashes: ActivityCalendarCursorHashes,
  last: ActivityCalendarPosition,
): string {
  const envelope = checked(Envelope, {
    v: 1,
    kind: "activity-calendar",
    ...checked(Binding, binding),
    ...checked(Hashes, hashes),
    last,
  });
  const raw = Buffer.from(JSON.stringify(envelope), "utf8").toString(
    "base64url",
  );
  if (raw.length > ACTIVITY_CALENDAR_CURSOR_MAX_LENGTH) {
    throw new ValidationFailedError("malformed activity calendar cursor");
  }
  return raw;
}

/** Check binding before comparing hashes so wrong-query cursors always return 422. */
export function decodeActivityCalendarCursor(
  raw: string,
  binding: ActivityCalendarCursorBinding,
  hashes?: ActivityCalendarCursorHashes,
): ActivityCalendarCursor {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > ACTIVITY_CALENDAR_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) {
    throw new ValidationFailedError("malformed activity calendar cursor");
  }
  let value: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    // Buffer's decoder otherwise accepts noncanonical encodings and invalid UTF-8.
    if (bytes.toString("base64url") !== raw)
      throw new Error("invalid base64url");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ValidationFailedError("malformed activity calendar cursor");
  }
  const cursor = checked(Envelope, value);
  const expected = checked(Binding, binding);
  if (
    cursor.viewer_id !== expected.viewer_id ||
    cursor.scope.type !== expected.scope.type ||
    cursor.scope.id !== expected.scope.id ||
    cursor.year !== expected.year ||
    cursor.day !== expected.day ||
    cursor.tz !== expected.tz ||
    cursor.limit !== expected.limit
  ) {
    throw new ValidationFailedError(
      "activity calendar cursor does not match query",
    );
  }
  if (hashes !== undefined) assertActivityCalendarHashes(cursor, hashes);
  return cursor;
}

/** Hashes must come from fresh authorization and the entire freshly read selected-day set. */
export function assertActivityCalendarHashes(
  cursor: ActivityCalendarCursorHashes,
  current: ActivityCalendarCursorHashes,
): void {
  const expected = checked(Hashes, current);
  if (
    cursor.scope_hash !== expected.scope_hash ||
    cursor.set_hash !== expected.set_hash
  ) {
    throw new ConflictError("activity changed; restart pagination", {
      reason: "activity_changed",
      restart: true,
    });
  }
}

/**
 * Page a complete, unique selected-day set, retaining the caller's row payloads.
 * Authorization, snapshot reads, timestamp normalization, and final scope rechecks
 * remain the aggregator's responsibility; cursor data never selects projects.
 */
export function paginateActivityCalendar<T extends ActivityCalendarCursorRow>(
  rows: readonly T[],
  projectIds: readonly number[],
  binding: ActivityCalendarCursorBinding,
  after?: string,
): {
  total: number;
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
} {
  const expected = checked(Binding, binding);
  const cursor =
    after === undefined
      ? undefined
      : decodeActivityCalendarCursor(after, expected);
  const hashes = {
    scope_hash: activityCalendarScopeHash(projectIds),
    set_hash: activityCalendarSetHash(rows),
  };
  if (cursor) assertActivityCalendarHashes(cursor, hashes);
  const ordered = rows
    .map((row) => ({ row, position: positionOf(row) }))
    .sort((a, b) => compareActivityCalendarPositions(a.position, b.position));
  const remaining = cursor
    ? ordered.filter(({ position }) =>
        isAfterActivityCalendarPosition(position, cursor.last),
      )
    : ordered;
  const page = remaining.slice(0, expected.limit);
  const has_more = remaining.length > page.length;
  return {
    total: rows.length,
    items: page.map(({ row }) => row),
    has_more,
    next_cursor: has_more
      ? encodeActivityCalendarCursor(
          expected,
          hashes,
          page[page.length - 1]!.position,
        )
      : null,
  };
}
