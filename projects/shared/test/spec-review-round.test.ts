import { describe, expect, it } from "vitest";
import { SpecInfo } from "../src/index.ts";

const info = {
  current_version: 1,
  current_version_cursor: "push-cursor",
  review_status: "approved",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [{ path: "design.md", size: 10 }],
  versions: [
    {
      number: 1,
      author: {
        id: 1,
        login: "round-pusher",
        display_name: "Round pusher",
        kind: "human",
        avatar_url: null,
        owner: null,
      },
      message: null,
      created_at: "2026-09-19T12:00:00.000Z",
    },
  ],
};

describe("SpecInfo viewer_review", () => {
  it.each(["unreviewed", "approved", "changes_requested", "withdrawn"])(
    "preserves absence without defaulting personal state when globally %s",
    (review_status) => {
      const legacy = { ...info, review_status };
      const parsed = SpecInfo.parse(legacy);
      expect(parsed).toEqual(legacy);
      expect(parsed).not.toHaveProperty("viewer_review");
      expect(parsed.viewer_review).toBeUndefined();
    },
  );

  it.each([true, false])(
    "preserves the explicit boolean %s and numeric user id",
    (approved) => {
      const response = {
        ...info,
        viewer_review: { user_id: 2, approved_in_current_round: approved },
      };
      const parsed = SpecInfo.parse(response);
      expect(parsed).toEqual(response);
      expect(parsed.viewer_review).toEqual({
        user_id: 2,
        approved_in_current_round: approved,
      });
      expect(typeof parsed.viewer_review?.user_id).toBe("number");
      expect(typeof parsed.viewer_review?.approved_in_current_round).toBe(
        "boolean",
      );
    },
  );

  it.each([0, -1, 1.5, "2", true, false, null, undefined, NaN, Infinity])(
    "rejects invalid Id %s without coercion",
    (user_id) => {
      const result = SpecInfo.safeParse({
        ...info,
        viewer_review: { user_id, approved_in_current_round: true },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
          "viewer_review",
          "user_id",
        ]);
      }
    },
  );

  it.each(
    ["true", "false", 0, 1, null, undefined, {}, []].map((value) => ({
      value,
    })),
  )(
    "rejects invalid approval boolean $value without coercion or a default",
    ({ value: approved_in_current_round }) => {
      const result = SpecInfo.safeParse({
        ...info,
        viewer_review: { user_id: 2, approved_in_current_round },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
          "viewer_review",
          "approved_in_current_round",
        ]);
      }
    },
  );

  it.each(
    [
      null,
      false,
      "approved",
      [],
      {},
      { user_id: 2 },
      { approved_in_current_round: false },
    ].map((value) => ({ value })),
  )("rejects malformed or incomplete personal state $value", ({ value }) => {
    expect(SpecInfo.safeParse({ ...info, viewer_review: value }).success).toBe(
      false,
    );
  });
});
