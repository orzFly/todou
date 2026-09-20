import { describe, expect, it } from "vitest";
import { userSearchParams, userSearchSchema } from "../src/api/users.ts";

const activity = { activity_day: "2024-02-29" };

describe("user search", () => {
  it("does not accept URL notice metadata, including JSON boolean true", () => {
    expect(
      userSearchSchema({
        role: "author",
        state: "all",
        ...activity,
        activity_invalid: true,
      }),
    ).toEqual({ role: "author", state: "all", ...activity });
  });

  it("serializes public filters without a derived invalid-date marker", () => {
    const invalid = {
      role: "assignee",
      state: "closed",
      activity_day: "2024-02-30",
    };
    expect(userSearchSchema(invalid).activity_invalid).toBe(true);
    expect(userSearchParams(invalid)).toEqual({
      role: "assignee",
      state: "closed",
    });
    expect(
      userSearchParams({
        ...userSearchSchema(invalid),
        role: "author",
        state: "all",
      }),
    ).toEqual({ role: "author", state: "all" });
  });

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
    ["nonexistent day", { activity_day: "2024-02-30" }, {}],
    ["numeric day", { activity_day: 20240229 }, {}],
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
      activity_day: "2026-03-08",
    });
    expect(changed).toStrictEqual({
      role: "assignee",
      state: "closed",
      activity_day: "2026-03-08",
    });
    expect(
      userSearchSchema({ ...changed, activity_day: undefined }),
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
