import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConflictError, ValidationFailedError } from "../src/errors.ts";
import {
  ACTIVITY_CALENDAR_CURSOR_MAX_LENGTH,
  type ActivityCalendarCursorBinding,
  type ActivityCalendarCursorRow,
  activityCalendarScopeHash,
  activityCalendarSetHash,
  assertActivityCalendarHashes,
  compareActivityCalendarPositions,
  decodeActivityCalendarCursor,
  encodeActivityCalendarCursor,
  isAfterActivityCalendarPosition,
  paginateActivityCalendar,
} from "../src/services/activity-calendar/cursor.ts";
import {
  encodeListCursor,
  encodeTimelineCursor,
} from "../src/services/cursor.ts";

const binding: ActivityCalendarCursorBinding = {
  viewer_id: 7,
  scope: { type: "user", id: 8 },
  from: "2026-01-01",
  to: "2027-01-01",
  day: "2026-09-01",
  tz: "UTC",
  limit: 2,
};
const at = "2026-09-01T12:00:00.123456Z";
const rows = [
  { project_id: 10, issue_id: 1, last_active_at: at, title: "third" },
  { project_id: 2, issue_id: 10, last_active_at: at, title: "second" },
  { project_id: 2, issue_id: 2, last_active_at: at, title: "first" },
  {
    project_id: 2,
    issue_id: 1,
    last_active_at: "2026-09-01T12:00:00.123455Z",
    title: "fourth",
  },
  {
    project_id: 10,
    issue_id: 2,
    last_active_at: "2026-09-01T12:00:00.123454Z",
    title: "fifth",
  },
];
const hashes = {
  scope_hash: activityCalendarScopeHash([2, 10]),
  set_hash: activityCalendarSetHash(rows),
};
const last = { at, project_id: 2, issue_id: 10 };
const envelope = {
  v: 1,
  kind: "activity-calendar",
  ...binding,
  ...hashes,
  last,
};

/** Encode arbitrary wire input without the production encoder's validation. */
function wire(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function expectValidation(fn: () => unknown): void {
  expect(fn).toThrow(ValidationFailedError);
  expect(fn).toThrow(
    expect.objectContaining({ status: 422, code: "validation_failed" }),
  );
}

function expectChanged(fn: () => unknown): void {
  expect(fn).toThrow(ConflictError);
  expect(fn).toThrow(
    expect.objectContaining({
      status: 409,
      code: "conflict",
      details: { reason: "activity_changed", restart: true },
    }),
  );
}

describe("activity calendar v1 cursor", () => {
  it("encodes exactly the base64url JSON envelope and preserves microseconds", () => {
    const raw = encodeActivityCalendarCursor(binding, hashes, last);
    expect(raw).toBe(wire(envelope));
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActivityCalendarCursor(raw, binding, hashes)).toEqual(
      envelope,
    );
  });

  it("rejects malformed, oversized, noncanonical and non-UTF-8 encodings", () => {
    const valid = wire(envelope);
    for (const raw of [
      "",
      "!",
      "e30=",
      "e30\n",
      "e30+",
      "e30/",
      "a",
      "e31",
      `${valid}=`,
      ` ${valid}`,
      `${valid}\n`,
      "a".repeat(ACTIVITY_CALENDAR_CURSOR_MAX_LENGTH + 1),
      Buffer.from("{broken json", "utf8").toString("base64url"),
      Buffer.from([0x22, 0xff, 0x22]).toString("base64url"),
      wire(null),
      wire([]),
      wire(1),
      wire("cursor"),
      wire({}),
    ]) {
      expectValidation(() => decodeActivityCalendarCursor(raw, binding));
    }
    expectValidation(() =>
      decodeActivityCalendarCursor(null as unknown as string, binding),
    );
  });

  it("accepts the exact size bound but rejects the next character", () => {
    const json = JSON.stringify(envelope);
    // 6144 ASCII bytes encode to exactly 8192 base64url characters.
    const bounded = Buffer.from(json.padEnd(6144, " ")).toString("base64url");
    expect(bounded).toHaveLength(ACTIVITY_CALENDAR_CURSOR_MAX_LENGTH);
    expect(decodeActivityCalendarCursor(bounded, binding)).toEqual(envelope);
    expectValidation(() =>
      decodeActivityCalendarCursor(`${bounded}A`, binding),
    );
  });

  it("requires every field and rejects unknown fields at every object level", () => {
    for (const key of Object.keys(envelope)) {
      const missing: Record<string, unknown> = { ...envelope };
      delete missing[key];
      expectValidation(() =>
        decodeActivityCalendarCursor(wire(missing), binding),
      );
    }
    for (const changed of [
      { ...envelope, cutoff: at },
      { ...envelope, scope: { ...binding.scope, projects: [2, 10] } },
      { ...envelope, last: { ...last, title: "hidden" } },
    ]) {
      expectValidation(() =>
        decodeActivityCalendarCursor(wire(changed), binding),
      );
    }
  });

  it("rejects invalid versions, kinds, types, enums, IDs, hashes and query limits", () => {
    const changes: Record<string, unknown>[] = [
      { v: 2 },
      { v: "1" },
      { kind: "timeline" },
      { viewer_id: "7" },
      { viewer_id: 0 },
      { viewer_id: Number.MAX_SAFE_INTEGER + 1 },
      { scope: null },
      { scope: [] },
      { scope: { type: "team", id: 8 } },
      { scope: { type: "user", id: -1 } },
      { scope: { type: "user", id: 1.5 } },
      { from: 0 },
      { from: "2026-02-30" },
      { to: undefined },
      { to: "2026-01-01" },
      { day: "2026-02-29" },
      { day: "2026-04-31" },
      { day: "2025-09-01" },
      { day: "2026-00-01" },
      { day: "2026-13-01" },
      { day: "2026-09-00" },
      { day: "2026-09-01\n" },
      { tz: "" },
      { tz: "x".repeat(101) },
      { tz: 123 },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: "2" },
      { limit: true },
      { scope_hash: "a".repeat(63) },
      { scope_hash: "A".repeat(64) },
      { set_hash: "g".repeat(64) },
      { set_hash: 123 },
      { scope_hash: `${hashes.scope_hash}\n` },
      { set_hash: `${hashes.set_hash}\n` },
      { last: null },
      { last: { at, project_id: 2 } },
      { last: { ...last, project_id: 0 } },
      { last: { ...last, issue_id: "10" } },
      { last: { ...last, issue_id: Number.MAX_SAFE_INTEGER + 1 } },
    ];
    for (const change of changes) {
      expectValidation(() =>
        decodeActivityCalendarCursor(wire({ ...envelope, ...change }), binding),
      );
    }
  });

  it("rejects noncanonical timestamps and impossible Gregorian dates", () => {
    for (const timestamp of [
      "2026-09-01T12:00:00.123Z",
      "2026-09-01T12:00:00.1234567Z",
      "2026-09-01T12:00:00.123456+00:00",
      "2026-09-01 12:00:00.123456Z",
      "2026-09-01T24:00:00.123456Z",
      "2026-09-01T12:60:00.123456Z",
      "2026-09-01T12:00:60.123456Z",
      "2026-02-29T12:00:00.123456Z",
      "1900-02-29T12:00:00.123456Z",
      "0000-01-01T12:00:00.123456Z",
      "2026-09-01T12:00:00.123456Z\n",
    ]) {
      expectValidation(() =>
        decodeActivityCalendarCursor(
          wire({
            ...envelope,
            last: { ...last, at: timestamp },
          }),
          binding,
        ),
      );
    }
  });

  it("accepts leap days and years outside safe numeric epoch-microsecond ranges", () => {
    for (const timestamp of [
      "0001-01-01T00:00:00.000001Z",
      "2000-02-29T00:00:00.000001Z",
      "2400-02-29T00:00:00.000001Z",
      "9998-12-31T23:59:59.999999Z",
    ]) {
      const day = timestamp.slice(0, 10);
      // The envelope only requires the day to fall inside its window; the
      // window's own length is the query schema's business, not the cursor's.
      const query = { ...binding, from: day, to: "9999-01-01", day };
      const position = { ...last, at: timestamp };
      expect(
        decodeActivityCalendarCursor(
          encodeActivityCalendarCursor(query, hashes, position),
          query,
        ).last,
      ).toEqual(position);
    }
  });

  it("binds viewer, scope kind/id, window, day, timezone and limit before checking hashes", () => {
    const changes: Partial<ActivityCalendarCursorBinding>[] = [
      { viewer_id: 9 },
      { scope: { type: "project", id: 8 } },
      { scope: { type: "user", id: 9 } },
      { from: "2025-01-01", to: "2026-01-01", day: "2025-09-01" },
      { day: "2026-09-02" },
      { tz: "Etc/UTC" },
      { limit: 3 },
    ];
    for (const change of changes) {
      expectValidation(() =>
        decodeActivityCalendarCursor(
          wire(envelope),
          { ...binding, ...change },
          {
            ...hashes,
            scope_hash: activityCalendarScopeHash([]),
          },
        ),
      );
    }
    expectValidation(() =>
      decodeActivityCalendarCursor(wire(envelope), {
        ...binding,
        day: undefined,
      } as unknown as ActivityCalendarCursorBinding),
    );
  });

  it("rejects ordinary timeline and issue-list cursors", () => {
    for (const raw of [
      encodeTimelineCursor({ t: at, k: 1, i: 10 }),
      encodeListCursor({ v: at, i: 10 }),
      wire({ t: at, k: 1, i: 10 }),
      wire({ v: at, i: 10 }),
    ]) {
      expectValidation(() => decodeActivityCalendarCursor(raw, binding));
    }
  });

  it("reports scope and set changes without disclosing their differences", () => {
    for (const current of [
      { ...hashes, scope_hash: activityCalendarScopeHash([2]) },
      { ...hashes, scope_hash: activityCalendarScopeHash([2, 10, 20]) },
      { ...hashes, set_hash: activityCalendarSetHash(rows.slice(1)) },
      {
        ...hashes,
        set_hash: activityCalendarSetHash(
          rows.map((row, i) =>
            i === 0
              ? { ...row, last_active_at: "2026-09-01T12:00:00.123457Z" }
              : row,
          ),
        ),
      },
    ]) {
      expectChanged(() =>
        decodeActivityCalendarCursor(wire(envelope), binding, current),
      );
      expectChanged(() => assertActivityCalendarHashes(envelope, current));
    }
  });
});

describe("canonical activity digests", () => {
  it("fixes scope serialization as a numerically sorted unique JSON ID array", () => {
    expect(activityCalendarScopeHash([10, 2, 2])).toBe(
      createHash("sha256").update("[2,10]", "utf8").digest("hex"),
    );
    expect(activityCalendarScopeHash([10, 2])).toBe(
      activityCalendarScopeHash([2, 10]),
    );
    expect(activityCalendarScopeHash([10])).not.toBe(
      activityCalendarScopeHash([]),
    );
    expect(activityCalendarScopeHash([])).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
  });

  it("fixes set serialization by permanent identity, independent of display order and fields", () => {
    const canonical =
      '[[2,1,"2026-09-01T12:00:00.123455Z"],[2,2,"2026-09-01T12:00:00.123456Z"],[2,10,"2026-09-01T12:00:00.123456Z"],[10,1,"2026-09-01T12:00:00.123456Z"],[10,2,"2026-09-01T12:00:00.123454Z"]]';
    expect(activityCalendarSetHash(rows)).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
    expect(
      activityCalendarSetHash(
        [...rows].reverse().map((row) => ({
          ...row,
          title: "renamed",
          number: 99,
          slug: "renamed-project",
          status: { id: 5 },
        })),
      ),
    ).toBe(hashes.set_hash);
    expect(activityCalendarSetHash([])).toBe(activityCalendarScopeHash([]));
    expect(
      activityCalendarSetHash([
        { ...rows[0]!, issue_id: 99 },
        ...rows.slice(1),
      ]),
    ).not.toBe(hashes.set_hash);
    expect(
      activityCalendarSetHash([
        { ...rows[0]!, project_id: 99 },
        ...rows.slice(1),
      ]),
    ).not.toBe(hashes.set_hash);
  });

  it("distinguishes project ownership with identical issue IDs, timestamps and row order", () => {
    const anchor = { project_id: 2, issue_id: 1, last_active_at: at };
    const left = { project_id: 2, issue_id: 2, last_active_at: at };
    const right = { ...left, project_id: 10 };
    // A singleton cannot accidentally detect project omission via sort order.
    expect(activityCalendarSetHash([left])).not.toBe(
      activityCalendarSetHash([right]),
    );
    for (const [source, destination] of [
      [left, right],
      [right, left],
    ] as const) {
      // The anchor sorts before either twin by timestamp during pagination.
      const selected = {
        ...source,
        last_active_at: "2026-09-01T12:00:00.123455Z",
      };
      const swapped = { ...selected, project_id: destination.project_id };
      const query = { ...binding, limit: 1 };
      const first = paginateActivityCalendar(
        [anchor, selected],
        [2, 10],
        query,
      );
      const cursor = first.next_cursor;
      if (!cursor) throw new Error("expected identity fixture continuation");
      expectChanged(() =>
        paginateActivityCalendar([anchor, swapped], [2, 10], query, cursor),
      );
      const renamed = { ...selected, title: "renamed", number: 99 };
      expect(activityCalendarSetHash([renamed, anchor])).toBe(
        activityCalendarSetHash([anchor, selected]),
      );
      expect(
        paginateActivityCalendar([renamed, anchor], [10, 2], query, cursor),
      ).toEqual({
        total: 2,
        items: [renamed],
        has_more: false,
        next_cursor: null,
      });
    }
  });

  it("rejects duplicate identities and noncanonical digest inputs", () => {
    expectValidation(() => activityCalendarSetHash([...rows, rows[0]!]));
    expectValidation(() =>
      activityCalendarSetHash([
        { ...rows[0]!, last_active_at: "2026-09-01T12:00:00.123Z" },
      ]),
    );
    expectValidation(() => activityCalendarScopeHash([0]));
  });
});

describe("activity calendar keyset pagination", () => {
  it("compares microseconds before numeric project and issue ID tie breakers", () => {
    expect(compareActivityCalendarPositions(last, last)).toBe(0);
    expect(isAfterActivityCalendarPosition(last, last)).toBe(false);
    expect(
      isAfterActivityCalendarPosition({ ...last, issue_id: 11 }, last),
    ).toBe(true);
    expect(
      isAfterActivityCalendarPosition(
        { ...last, project_id: 10, issue_id: 1 },
        last,
      ),
    ).toBe(true);
    expect(
      isAfterActivityCalendarPosition({ ...last, issue_id: 2 }, last),
    ).toBe(false);
    expect(
      isAfterActivityCalendarPosition(
        { ...last, at: "2026-09-01T12:00:00.123455Z", project_id: 1 },
        last,
      ),
    ).toBe(true);
    expect(
      isAfterActivityCalendarPosition(
        { ...last, at: "2026-09-01T12:00:00.123457Z", project_id: 99 },
        last,
      ),
    ).toBe(false);
  });

  it("continues from the last delivered row and drains once without skips or repeats", () => {
    const first = paginateActivityCalendar(rows, [10, 2], binding);
    expect(first.total).toBe(5);
    expect(first.items.map((row) => row.title)).toEqual(["first", "second"]);
    expect(first.has_more).toBe(true);
    expect(
      decodeActivityCalendarCursor(first.next_cursor!, binding, hashes).last,
    ).toEqual(last);
    const second = paginateActivityCalendar(
      [...rows].reverse(),
      [2, 10],
      binding,
      first.next_cursor!,
    );
    expect(second.items.map((row) => row.title)).toEqual(["third", "fourth"]);
    const third = paginateActivityCalendar(
      rows,
      [2, 10],
      binding,
      second.next_cursor!,
    );
    expect(third.items.map((row) => row.title)).toEqual(["fifth"]);
    expect(third).toMatchObject({
      total: 5,
      has_more: false,
      next_cursor: null,
    });
    const identities = [...first.items, ...second.items, ...third.items].map(
      (row) => `${row.project_id}:${row.issue_id}`,
    );
    expect(new Set(identities).size).toBe(first.total);
    expect(rows.map((row) => row.title)).toEqual([
      "third",
      "second",
      "first",
      "fourth",
      "fifth",
    ]);
  });

  it.each([1, 100])(
    "honors limit %i and only emits a cursor when an extra row exists",
    (limit) => {
      const query = { ...binding, limit };
      const exact: ActivityCalendarCursorRow[] = Array.from(
        { length: limit },
        (_, i) => ({
          project_id: 2,
          issue_id: i + 1,
          last_active_at: at,
        }),
      );
      expect(paginateActivityCalendar(exact, [2], query)).toMatchObject({
        total: limit,
        items: exact,
        has_more: false,
        next_cursor: null,
      });
      const more = [
        ...exact,
        { project_id: 2, issue_id: limit + 1, last_active_at: at },
      ];
      const page = paginateActivityCalendar(more, [2], query);
      expect(page.items).toHaveLength(limit);
      expect(page.has_more).toBe(true);
      expect(
        decodeActivityCalendarCursor(page.next_cursor!, query).last.issue_id,
      ).toBe(limit);
    },
  );

  it("handles empty sets and rejects invalid limits even on an empty first page", () => {
    expect(paginateActivityCalendar([], [], binding)).toEqual({
      total: 0,
      items: [],
      has_more: false,
      next_cursor: null,
    });
    for (const limit of [0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectValidation(() =>
        paginateActivityCalendar([], [], { ...binding, limit }),
      );
      expectValidation(() =>
        encodeActivityCalendarCursor({ ...binding, limit }, hashes, last),
      );
    }
  });

  it("keeps an exhausted position exhausted and permits display-only changes", () => {
    const terminal = encodeActivityCalendarCursor(binding, hashes, {
      at: "2026-09-01T12:00:00.123454Z",
      project_id: 10,
      issue_id: 2,
    });
    expect(paginateActivityCalendar(rows, [2, 10], binding, terminal)).toEqual({
      total: 5,
      items: [],
      has_more: false,
      next_cursor: null,
    });
    const first = paginateActivityCalendar(rows, [2, 10], binding);
    const renamed = rows.map((row) => ({ ...row, title: "renamed" }));
    const next = paginateActivityCalendar(
      renamed,
      [10, 2],
      binding,
      first.next_cursor!,
    );
    expect(
      next.items.map((row) => [row.project_id, row.issue_id, row.title]),
    ).toEqual([
      [10, 1, "renamed"],
      [2, 1, "renamed"],
    ]);
  });

  it("rejects changed scope, additions, deletions and microsecond changes on continuation", () => {
    const page = paginateActivityCalendar(rows, [2, 10], binding);
    expectChanged(() =>
      paginateActivityCalendar(rows, [2], binding, page.next_cursor!),
    );
    expectChanged(() =>
      paginateActivityCalendar(
        rows.slice(1),
        [2, 10],
        binding,
        page.next_cursor!,
      ),
    );
    expectChanged(() =>
      paginateActivityCalendar(
        [
          ...rows,
          {
            project_id: 2,
            issue_id: 20,
            last_active_at: at,
          },
        ],
        [2, 10],
        binding,
        page.next_cursor!,
      ),
    );
    expectChanged(() =>
      paginateActivityCalendar(
        rows.map((row, i) =>
          i === 0
            ? { ...row, last_active_at: "2026-09-01T12:00:00.123457Z" }
            : row,
        ),
        [2, 10],
        binding,
        page.next_cursor!,
      ),
    );
  });
});
