import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ActivityCalendarQuery,
  type ActivityCalendarQueryInput,
  ActivityCalendarResponse,
  ActivityCard,
  ActivityDay,
  ActivitySelection,
  TodouClient,
} from "../src/index.ts";

function dayBounds(date: string): { start: string; end: string } {
  // Cases that feed deliberately malformed dates still need a parseable pair:
  // the assertion under test is about `date`, not about these.
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed))
    return {
      start: "2024-01-01T00:00:00.000Z",
      end: "2024-01-02T00:00:00.000Z",
    };
  const next = new Date(parsed + 86_400_000).toISOString().slice(0, 10);
  return { start: `${date}T00:00:00.000Z`, end: `${next}T00:00:00.000Z` };
}

const query = { from: "2024-01-01", to: "2025-01-01", tz: "UTC" };
const day = "2024-02-29";
const timestamp = "2024-02-29T12:34:56.123456Z";
const card = {
  project: { id: 1, slug: "demo", name: "Demo", issue_prefix: null },
  issue_id: 3,
  number: 7,
  title: "Example card",
  status: {
    id: 2,
    name: "Done",
    category: "closed",
    color: "#aAbBcC",
    position: 0,
    is_default: false,
  },
  url: "/projects/demo/issues/7",
  last_active_at: timestamp,
};
const selection = {
  date: day,
  total: 1,
  items: [card],
  next_cursor: null,
  has_more: false,
};
const response = {
  from: "2024-01-01",
  to: "2025-01-01",
  timezone: "UTC",
  cutoff: "2025-01-01T00:00:00.000001Z",
  read_started_at: "2025-01-01T00:00:00.000002Z",
  read_finished_at: "2025-01-01T00:00:00.000003Z",
  days: Array.from({ length: 366 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 0, index + 1))
      .toISOString()
      .slice(0, 10);
    return {
      date,
      ...dayBounds(date),
      state: "recorded",
      count: date === day ? 1 : 0,
    };
  }),
  selection,
};

// These are structural contracts. Database timezone recognition, cutoff/birth
// rules, cursor decoding and calendar cross-row invariants belong to the server.
describe("ActivityCalendarQuery", () => {
  it("coerces URL numbers and applies only the limit default", () => {
    expect(ActivityCalendarQuery.parse({ ...query })).toEqual({
      ...query,
      limit: 50,
    });
    expect(
      ActivityCalendarQuery.parse({
        ...query,
        day,
        limit: "100",
        after: "opaque",
      }),
    ).toEqual({ ...query, day, limit: 100, after: "opaque" });
    expect(
      ActivityCalendarQuery.parse({ ...query, limit: undefined }).limit,
    ).toBe(50);
  });

  it.each([
    ["0001-01-01", "0001-02-01", "0001-01-01"],
    ["0004-02-01", "0004-03-01", "0004-02-29"],
    ["1900-02-01", "1900-03-01", "1900-02-28"],
    ["2000-02-01", "2000-03-01", "2000-02-29"],
    ["2024-02-01", "2024-03-01", "2024-02-29"],
    ["9998-12-01", "9998-12-31", "9998-12-30"],
  ])(
    "accepts Gregorian boundary window %s..%s and day %s",
    (from, to, date) => {
      expect(
        ActivityCalendarQuery.parse({
          from,
          to,
          tz: "UTC",
          day: date,
          limit: 1,
        }).day,
      ).toBe(date);
    },
  );

  it.each([
    "2023-02-29",
    "1900-02-29",
    "2100-02-29",
    "2024-02-30",
    "2024-04-31",
    "2024-00-01",
    "2024-13-01",
    "2024-01-00",
    "2024-01-32",
    "0000-01-01",
    "2024-2-29",
    "2024-02-9",
    "2024-02-29T00:00:00Z",
    "2024-02-29\n",
    " 2024-02-29",
  ])("rejects invalid calendar date %j in queries and responses", (date) => {
    expect(
      ActivityCalendarQuery.safeParse({ ...query, day: date }).success,
    ).toBe(false);
    expect(
      ActivityCalendarQuery.safeParse({ ...query, from: date }).success,
    ).toBe(false);
    expect(
      ActivityDay.safeParse({
        date,
        ...dayBounds(date),
        state: "recorded",
        count: 0,
      }).success,
    ).toBe(false);
    expect(ActivitySelection.safeParse({ ...selection, date }).success).toBe(
      false,
    );
  });

  it("rejects an otherwise valid day outside the window", () => {
    for (const outside of ["2023-12-31", "2025-01-01"]) {
      expect(
        ActivityCalendarQuery.safeParse({ ...query, day: outside }).success,
      ).toBe(false);
    }
    // The window end is exclusive, so its last selectable day is the one before.
    expect(
      ActivityCalendarQuery.safeParse({ ...query, day: "2024-12-31" }).success,
    ).toBe(true);
  });

  it.each(["limit"] as const)(
    "rejects invalid numeric kinds for %s",
    (field) => {
      for (const value of [
        true,
        false,
        null,
        [],
        [1],
        ["2024"],
        {},
        { valueOf: () => 1 },
      ]) {
        expect(
          ActivityCalendarQuery.safeParse({ ...query, [field]: value }).success,
        ).toBe(false);
      }
    },
  );

  it.each([
    { from: undefined },
    { to: undefined },
    { from: 2024 },
    { to: "2024-01-01" },
    { from: "2025-01-01" },
    // 367 days: one past the widest window the contract allows.
    { from: "2024-01-01", to: "2025-01-02" },
    { limit: 0 },
    { limit: -1 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: NaN },
    { limit: Infinity },
    { limit: "" },
    { limit: "1x" },
  ])("rejects missing or out-of-range numbers %j", (patch) => {
    expect(
      ActivityCalendarQuery.safeParse({ ...query, ...patch }).success,
    ).toBe(false);
  });

  it.each([
    "range",
    "grain",
    "role",
    "state",
    "actor",
    "project_ids",
    "updated_at",
    "as_of",
    "activity_year",
    "activity_day",
    "cursor",
    "unknown",
  ])("rejects unknown query field %s", (field) => {
    expect(
      ActivityCalendarQuery.safeParse({ ...query, [field]: "anything" })
        .success,
    ).toBe(false);
  });

  it("requires day whenever after is present, including an empty string", () => {
    for (const after of ["opaque", ""]) {
      expect(ActivityCalendarQuery.safeParse({ ...query, after }).success).toBe(
        false,
      );
      // The shared contract imposes a maximum, not an invented minimum or
      // cursor grammar. The endpoint decodes and validates the envelope.
      expect(
        ActivityCalendarQuery.safeParse({ ...query, day, after }).success,
      ).toBe(true);
    }
  });

  it("accepts the specified string boundaries and rejects overlong strings", () => {
    for (const tz of ["U", "UTC", "America/New_York", "x".repeat(100)]) {
      expect(ActivityCalendarQuery.safeParse({ ...query, tz }).success).toBe(
        true,
      );
    }
    for (const tz of [undefined, null, 1, ["UTC"], "", "x".repeat(101)]) {
      expect(ActivityCalendarQuery.safeParse({ ...query, tz }).success).toBe(
        false,
      );
    }
    expect(
      ActivityCalendarQuery.safeParse({
        ...query,
        day,
        after: "x".repeat(8192),
      }).success,
    ).toBe(true);
    for (const after of [null, 1, ["opaque"], "x".repeat(8193)]) {
      expect(
        ActivityCalendarQuery.safeParse({ ...query, day, after }).success,
      ).toBe(false);
    }
    for (const value of [null, 20240229, [day], {}]) {
      expect(
        ActivityCalendarQuery.safeParse({ ...query, day: value }).success,
      ).toBe(false);
    }
  });
});

describe("ActivityDay", () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    "accepts recorded count %i",
    (count) => {
      expect(
        ActivityDay.parse({
          date: day,
          ...dayBounds(day),
          state: "recorded",
          count,
        }).count,
      ).toBe(count);
    },
  );

  it.each(["future", "not_applicable"])("requires null for %s", (state) => {
    expect(
      ActivityDay.parse({ date: day, ...dayBounds(day), state, count: null })
        .count,
    ).toBeNull();
    for (const count of [0, 1, "0", undefined]) {
      expect(
        ActivityDay.safeParse({ date: day, ...dayBounds(day), state, count })
          .success,
      ).toBe(false);
    }
  });

  it.each([
    null,
    undefined,
    -1,
    0.5,
    "1",
    true,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid recorded count %j", (count) => {
    expect(
      ActivityDay.safeParse({
        date: day,
        ...dayBounds(day),
        state: "recorded",
        count,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown states and narrows the count by state", () => {
    expect(
      ActivityDay.safeParse({
        date: day,
        ...dayBounds(day),
        state: "unknown",
        count: null,
      }).success,
    ).toBe(false);
    const parsed = ActivityDay.parse({
      date: day,
      ...dayBounds(day),
      state: "recorded",
      count: 0,
    });
    if (parsed.state === "recorded") {
      expectTypeOf(parsed.count).toEqualTypeOf<number>();
    } else {
      expectTypeOf(parsed.count).toEqualTypeOf<null>();
    }
  });
});

describe("ActivityCard", () => {
  it("reuses project/status fields and preserves microsecond timestamps", () => {
    expect(ActivityCard.parse(card)).toEqual(card);
    const slug = "a".repeat(64);
    expect(
      ActivityCard.safeParse({
        ...card,
        project: {
          ...card.project,
          slug,
          name: "",
          issue_prefix: "custom-prefix",
        },
        title: "",
        url: `/projects/${slug}/issues/7`,
        last_active_at: "2024-02-29T18:04:56.123456+05:30",
        status: { ...card.status, category: "open", position: -1 },
      }).success,
    ).toBe(true);
  });

  it.each([
    "https://todou.example/projects/demo/issues/7",
    "//todou.example/projects/demo/issues/7",
    "javascript:alert(1)",
    "projects/demo/issues/7",
    "/projects/demo/issues/7?x=1",
    "/projects/demo/issues/7#comment-1",
    "/projects/demo/issues/7/",
    "/projects/other/issues/7",
    "/projects/demo/issues/8",
    "/projects/demo/issues/007",
    "/projects/demo/../demo/issues/7",
    "/projects/%64emo/issues/7",
    "/projects/demo%2Fother/issues/7",
    "/projects/demo\\other/issues/7",
    "/projects/demo/issues/7\n",
  ])("rejects unsafe or noncanonical url %j", (url) => {
    expect(ActivityCard.safeParse({ ...card, url }).success).toBe(false);
  });

  it("rejects invalid reused ids, project fields, statuses and timestamps", () => {
    for (const value of [0, -1, 1.5, "1", null]) {
      expect(ActivityCard.safeParse({ ...card, issue_id: value }).success).toBe(
        false,
      );
      expect(ActivityCard.safeParse({ ...card, number: value }).success).toBe(
        false,
      );
      expect(
        ActivityCard.safeParse({
          ...card,
          project: { ...card.project, id: value },
        }).success,
      ).toBe(false);
      expect(
        ActivityCard.safeParse({
          ...card,
          status: { ...card.status, id: value },
        }).success,
      ).toBe(false);
    }
    for (const slug of ["", "a".repeat(65), "Bad", "../demo", "demo/other"]) {
      expect(
        ActivityCard.safeParse({
          ...card,
          project: { ...card.project, slug },
          url: `/projects/${encodeURIComponent(slug)}/issues/7`,
        }).success,
      ).toBe(false);
    }
    for (const patch of [
      { category: "unknown" },
      { color: "red" },
      { position: 0.5 },
      { is_default: "false" },
    ]) {
      expect(
        ActivityCard.safeParse({
          ...card,
          status: { ...card.status, ...patch },
        }).success,
      ).toBe(false);
    }
    expect(
      ActivityCard.safeParse({
        ...card,
        project: { ...card.project, slug: "\uD800" },
      }).success,
    ).toBe(false);
    expect(
      ActivityCard.safeParse({
        ...card,
        project: { ...card.project, slug: "demo\n" },
        url: "/projects/demo\n/issues/7",
      }).success,
    ).toBe(false);
    for (const patch of [
      { name: 1 },
      { issue_prefix: 1 },
      { issue_prefix: undefined },
    ]) {
      expect(
        ActivityCard.safeParse({
          ...card,
          project: { ...card.project, ...patch },
        }).success,
      ).toBe(false);
    }
    for (const last_active_at of ["2024-02-29", "invalid", 1, null]) {
      expect(ActivityCard.safeParse({ ...card, last_active_at }).success).toBe(
        false,
      );
    }
    expect(ActivityCard.safeParse({ ...card, title: null }).success).toBe(
      false,
    );
  });
});

describe("ActivitySelection and ActivityCalendarResponse", () => {
  it("accepts an empty day, a final page and a continuation page", () => {
    expect(
      ActivitySelection.parse({ ...selection, total: 0, items: [] }),
    ).toEqual({
      ...selection,
      total: 0,
      items: [],
    });
    expect(ActivitySelection.parse(selection)).toEqual(selection);
    expect(
      ActivitySelection.safeParse({
        ...selection,
        total: 2,
        has_more: true,
        next_cursor: "opaque",
      }).success,
    ).toBe(true);
    // A final page need not contain every item counted by total.
    expect(
      ActivitySelection.safeParse({
        ...selection,
        total: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    expect(
      ActivitySelection.safeParse({
        ...selection,
        total: 2,
        has_more: true,
        next_cursor: "x".repeat(8192),
      }).success,
    ).toBe(true);
  });

  it.each([
    { has_more: true, next_cursor: null },
    { has_more: false, next_cursor: "opaque" },
    { has_more: false, next_cursor: "" },
    { has_more: "false" },
    { has_more: undefined },
    { next_cursor: undefined },
    { next_cursor: 1 },
    { has_more: true, next_cursor: "x".repeat(8193) },
    { total: -1 },
    { total: 1.5 },
    { total: "1" },
    { total: null },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { total: Infinity },
    { items: null },
    { items: [{ ...card, url: "https://todou.example" }] },
  ])("rejects invalid selection fields or cursor consistency %j", (patch) => {
    expect(
      ActivitySelection.safeParse({ ...selection, ...patch }).success,
    ).toBe(false);
  });

  it("accepts calendar-only and selected-day responses without changing timestamps", () => {
    expect(ActivityCalendarResponse.parse(response)).toEqual(response);
    expect(
      ActivityCalendarResponse.parse({ ...response, selection: null })
        .selection,
    ).toBeNull();
  });

  it.each(["cutoff", "read_started_at", "read_finished_at"] as const)(
    "requires Timestamp for %s",
    (field) => {
      for (const value of [undefined, null, "invalid", "2025-01-01", 1]) {
        expect(
          ActivityCalendarResponse.safeParse({ ...response, [field]: value })
            .success,
        ).toBe(false);
      }
    },
  );

  it.each([
    { from: 0 },
    { from: "2024-02-30" },
    { to: undefined },
    { to: "2024" },
    { timezone: "" },
    { timezone: "x".repeat(101) },
    { timezone: null },
    { days: undefined },
    { days: [{ date: day, ...dayBounds(day), state: "future", count: 0 }] },
    { selection: undefined },
    { selection: { ...selection, has_more: true } },
  ])("validates response fields and nested schemas %j", (patch) => {
    expect(
      ActivityCalendarResponse.safeParse({ ...response, ...patch }).success,
    ).toBe(false);
  });
});

describe("activity calendar typed client", () => {
  it("sends project and user GET requests with explicit query inputs and typed responses", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new TodouClient({
      baseUrl: "https://todou.example",
      fetch: fetchImpl,
    });
    const input: ActivityCalendarQueryInput = {
      from: "2024-01-01",
      to: "2025-01-01",
      tz: "UTC",
    };
    const projectResult = client.getProjectActivityCalendar("demo", input);
    expectTypeOf(projectResult).toEqualTypeOf<
      Promise<ActivityCalendarResponse>
    >();
    expectTypeOf<
      Parameters<typeof client.getProjectActivityCalendar>[1]
    >().toEqualTypeOf<ActivityCalendarQueryInput>();
    expectTypeOf<
      Parameters<typeof client.getUserActivityCalendar>[1]
    >().toEqualTypeOf<ActivityCalendarQueryInput>();
    await expect(projectResult).resolves.toEqual(response);
    const userResult = client.getUserActivityCalendar("alice", {
      from: "2024-01-01",
      to: "2025-01-01",
      tz: "America/New_York",
      day,
      limit: 1,
      after: "opaque+/=",
    });
    expectTypeOf(userResult).toEqualTypeOf<Promise<ActivityCalendarResponse>>();
    await expect(userResult).resolves.toEqual(response);
    await client.getUserActivityCalendar(42, input);
    await client.getProjectActivityCalendar("12", {
      ...input,
      day: undefined,
      limit: 100,
    });
    expect(calls).toEqual([
      {
        url: "https://todou.example/api/projects/demo/insights/activity?from=2024-01-01&to=2025-01-01&tz=UTC",
        method: "GET",
      },
      {
        url: "https://todou.example/api/users/alice/activity?from=2024-01-01&to=2025-01-01&tz=America%2FNew_York&day=2024-02-29&limit=1&after=opaque%2B%2F%3D",
        method: "GET",
      },
      {
        url: "https://todou.example/api/users/42/activity?from=2024-01-01&to=2025-01-01&tz=UTC",
        method: "GET",
      },
      {
        url: "https://todou.example/api/projects/12/insights/activity?from=2024-01-01&to=2025-01-01&tz=UTC&limit=100",
        method: "GET",
      },
    ]);
  });
});
