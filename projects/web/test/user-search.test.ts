import { describe, expect, it } from "vitest";
import { userSearchSchema } from "../src/api/users.ts";

const activity = {
  activity_year: 2024,
  activity_day: "2024-02-29",
};

describe("user search", () => {
  it.each([
    [{}, {}],
    [{ role: "any", state: "open" }, {}],
    [{ role: "author", state: "open" }, { role: "author" }],
    [{ role: "any", state: "closed" }, { state: "closed" }],
    [
      { role: "assignee", state: "closed", other: "ignored" },
      { role: "assignee", state: "closed" },
    ],
    [
      { role: "author", state: "all" },
      { role: "author", state: "all" },
    ],
  ])("preserves the exact legacy URL output for %j", (search, expected) => {
    expect(userSearchSchema(search)).toStrictEqual(expected);
  });

  it.each([
    ["author", "all"],
    ["assignee", "closed"],
  ])("keeps role %s and state %s alongside activity dates", (role, state) => {
    expect(
      userSearchSchema({
        role,
        state,
        activity_year: "2024",
        activity_day: "2024-02-29",
      }),
    ).toStrictEqual({ role, state, ...activity });
  });

  it("omits default user filters while preserving activity dates", () => {
    expect(
      userSearchSchema({ role: "any", state: "open", ...activity }),
    ).toStrictEqual(activity);
  });

  it.each([
    ["malformed day", { activity_day: "2026-03-08T00:00:00Z" }, {}],
    ["nonexistent day", { activity_day: "2026-02-29" }, {}],
    ["array day", { activity_day: ["2024-02-29"] }, {}],
    ["malformed year", { activity_year: "2026x" }, {}],
    ["array year", { activity_year: [2024] }, {}],
    [
      "mismatched year and day",
      { activity_year: 2024, activity_day: "2023-02-28" },
      { activity_year: 2024 },
    ],
    [
      "invalid day beside a valid year",
      { activity_year: 2024, activity_day: "2024-02-30" },
      { activity_year: 2024 },
    ],
    [
      "invalid year beside a valid day",
      { activity_year: true, activity_day: "2024-02-29" },
      { activity_day: "2024-02-29" },
    ],
  ])("keeps role and state with %s", (_case, invalid, preserved) => {
    expect(
      userSearchSchema({ role: "author", state: "all", ...invalid }),
    ).toStrictEqual({
      role: "author",
      state: "all",
      ...preserved,
      activity_invalid: true,
    });
  });

  it("retains role and state when the activity selection changes or clears", () => {
    const initial = userSearchSchema({
      role: "assignee",
      state: "closed",
      ...activity,
    });
    const changed = userSearchSchema({
      ...initial,
      activity_year: "2026",
      activity_day: "2026-03-08",
    });
    expect(changed).toStrictEqual({
      role: "assignee",
      state: "closed",
      activity_year: 2026,
      activity_day: "2026-03-08",
    });
    expect(
      userSearchSchema({
        ...changed,
        activity_year: undefined,
        activity_day: undefined,
      }),
    ).toStrictEqual({ role: "assignee", state: "closed" });
  });

  it("retains activity dates when role and state change or return to defaults", () => {
    const initial = userSearchSchema({
      role: "author",
      state: "all",
      ...activity,
    });
    const changed = userSearchSchema({
      ...initial,
      role: "assignee",
      state: "closed",
    });
    expect(changed).toStrictEqual({
      role: "assignee",
      state: "closed",
      ...activity,
    });
    expect(
      userSearchSchema({ ...changed, role: "any", state: "open" }),
    ).toStrictEqual(activity);
  });

  it.each(["reviewer", ["author"], true, 7, null])(
    "keeps valid dates and state with invalid role %j",
    (role) => {
      expect(
        userSearchSchema({ role, state: "all", ...activity }),
      ).toStrictEqual({
        state: "all",
        ...activity,
      });
    },
  );

  it.each(["archived", ["closed"], true, 7, null])(
    "keeps valid dates and role with invalid state %j",
    (state) => {
      expect(
        userSearchSchema({ role: "author", state, ...activity }),
      ).toStrictEqual({
        role: "author",
        ...activity,
      });
    },
  );

  it("keeps valid dates when both user filters are invalid", () => {
    expect(
      userSearchSchema({ role: "reviewer", state: "archived", ...activity }),
    ).toStrictEqual(activity);
  });
});
