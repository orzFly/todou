import { ValidationFailedError } from "../errors.ts";

/**
 * Pagination cursors: a bookmark saying "you have read the timeline up to
 * here". Clients treat them as opaque, but agents persist them across
 * process restarts and swap them between commands, so the wire format is a
 * compatibility surface — every version ever minted stays readable.
 *
 * Timeline cursors carry the three numbers the timeline is ordered by:
 *
 * - `t` — when the entry was created, to the microsecond. Microseconds are
 *   not decoration: several entries can share a millisecond, and a cursor
 *   that cannot tell them apart re-returns or skips the boundary row.
 * - `k` — which kind of entry: 0 = comment, 1 = event (status change, label
 *   added, …). At an identical timestamp comments rank before events, so
 *   the kind is part of the sort key, not a payload field.
 * - `i` — the entry's row id, the last tie-break when `t` and `k` are equal
 *   too, so any two entries have a definite order.
 *
 * "Resume after this cursor" means "entries whose (t, k, i) is strictly
 * greater". List cursors are the same idea over the issue list's own sort
 * key: `v` (the sort value) plus `i`.
 *
 * ## Versions
 *
 * The version rides in a `<digits>:` prefix — `:` is outside the base64url
 * alphabet, so the prefix alone discriminates old from new without trial
 * decoding, and shares its number space with the multi-project envelope
 * (see cursor-envelope.ts in @todou/shared).
 *
 * | 1 | implicit, no prefix | `base64url(JSON)` — read forever, never minted again |
 * | 2 | envelope            | cross-project positions, see cursor-envelope.ts      |
 * | 3 | `3:<t₃₆>.<k>.<i₃₆>` | timeline / activity / watch                          |
 * | 4 | `4:<tag><v₃₆>.<i₃₆>`| issue list, tag `t` = time key, `n` = number key     |
 *
 * Version 1 spent 67 characters on JSON braces, quoted key names and a
 * 27-character ISO timestamp, then paid base64's 4/3 to carry it; version 3
 * writes the same position as three base36 integers and lands at 18. The
 * decoder reads both and always will: an agent holding a version-1 cursor
 * from before the upgrade must not have its position invalidated.
 */

const TIMELINE_VERSION = "3";
const LIST_VERSION = "4";
const VERSION_PREFIX = /^(\d+):/;
const BASE36 = /^[0-9a-z]+$/;
/** The fixed-width form `microIso` selects out of postgres. */
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Timeline position: (created_at at µs precision, kind, row id). */
export type TimelineCursor = { t: string; k: 0 | 1; i: number };

/**
 * Issue list position. For the date sorts `v` carries the full microsecond
 * precision postgres stores; for `sort=number` it is the issue number.
 */
export type ListCursor = { v: string | number; i: number };

const KIND_COMMENT = 0 as const;
const KIND_EVENT = 1 as const;

function malformed(): never {
  throw new ValidationFailedError("malformed cursor");
}

/**
 * Microseconds since the epoch, taken from `microIso`'s fixed-width text.
 * The six fraction digits are read as text rather than handed to
 * `Date.parse`, whose behaviour past three digits is unspecified.
 */
function isoToMicros(t: string): number {
  if (!MICRO_ISO.test(t)) malformed();
  const seconds = Date.parse(`${t.slice(0, 19)}Z`);
  if (Number.isNaN(seconds)) malformed();
  return seconds * 1000 + Number(t.slice(20, 26));
}

/** Inverse of `isoToMicros`, rebuilding the same fixed width. */
function microsToIso(us: number): string {
  const ms = new Date(Math.floor(us / 1000)).toISOString();
  return `${ms.slice(0, -4)}${String(us % 1_000_000).padStart(6, "0")}Z`;
}

function fromBase36(raw: string): number {
  if (!BASE36.test(raw)) malformed();
  const value = Number.parseInt(raw, 36);
  if (!Number.isSafeInteger(value)) malformed();
  return value;
}

/** Microsecond counts stay safe integers until roughly the year 2255. */
function microsFromBase36(raw: string): number {
  const us = fromBase36(raw);
  if (us <= 0) malformed();
  return us;
}

export function encodeTimelineCursor(c: TimelineCursor): string {
  const t = isoToMicros(c.t).toString(36);
  return `${TIMELINE_VERSION}:${t}.${c.k}.${c.i.toString(36)}`;
}

export function decodeTimelineCursor(raw: string): TimelineCursor {
  const version = VERSION_PREFIX.exec(raw);
  if (!version) return decodeLegacyTimelineCursor(raw);
  if (version[1] !== TIMELINE_VERSION) malformed();

  const parts = raw.slice(version[0].length).split(".");
  if (parts.length !== 3) malformed();
  const [t, k, i] = parts;
  if (k !== String(KIND_COMMENT) && k !== String(KIND_EVENT)) malformed();
  return {
    t: microsToIso(microsFromBase36(t)),
    k: k === String(KIND_COMMENT) ? KIND_COMMENT : KIND_EVENT,
    i: fromBase36(i),
  };
}

/**
 * Version 1, still in the hands of every agent that started before the
 * upgrade. Millisecond-precision `t` values from even older servers pass
 * validation here and are widened to their whole millisecond by the
 * pagination predicates.
 */
function decodeLegacyTimelineCursor(raw: string): TimelineCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString(),
    ) as TimelineCursor;
    if (
      typeof parsed.t !== "string" ||
      Number.isNaN(Date.parse(parsed.t)) ||
      typeof parsed.i !== "number" ||
      (parsed.k !== KIND_COMMENT && parsed.k !== KIND_EVENT)
    ) {
      throw new Error("bad cursor");
    }
    return parsed;
  } catch {
    return malformed();
  }
}

export function encodeListCursor(c: ListCursor): string {
  const [tag, value] =
    typeof c.v === "number" ? ["n", c.v] : ["t", isoToMicros(c.v)];
  return `${LIST_VERSION}:${tag}${value.toString(36)}.${c.i.toString(36)}`;
}

/**
 * A cursor minted for one sort key is meaningless under another — an issue
 * number read as a timestamp lands in 1970 — so the tag is checked against
 * the sort the request actually asked for.
 */
export function decodeListCursor(
  raw: string,
  sortsByNumber: boolean,
): ListCursor {
  const cursor = decodeListCursorValue(raw);
  if ((typeof cursor.v === "number") !== sortsByNumber) malformed();
  return cursor;
}

function decodeListCursorValue(raw: string): ListCursor {
  const version = VERSION_PREFIX.exec(raw);
  if (!version) return decodeLegacyListCursor(raw);
  if (version[1] !== LIST_VERSION) malformed();

  const payload = raw.slice(version[0].length);
  const parts = payload.slice(1).split(".");
  if (parts.length !== 2) malformed();
  const [v, i] = parts;
  const tag = payload[0];
  if (tag !== "t" && tag !== "n") malformed();
  return {
    v: tag === "n" ? fromBase36(v) : microsToIso(microsFromBase36(v)),
    i: fromBase36(i),
  };
}

function decodeLegacyListCursor(raw: string): ListCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString(),
    ) as ListCursor;
    if (typeof parsed.i !== "number") throw new Error("bad cursor");
    if (typeof parsed.v !== "number" && typeof parsed.v !== "string") {
      throw new Error("bad cursor");
    }
    return parsed;
  } catch {
    return malformed();
  }
}
