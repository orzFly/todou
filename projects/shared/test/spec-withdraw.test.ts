import { describe, expect, it } from "vitest";
import {
  Issue,
  IssueListItem,
  SpecInfo,
  SpecReviewStatus,
  SpecReviewSubmitInput,
  SpecReviewVerdict,
  SpecVersionInfo,
  SpecWithdrawInput,
  SpecWithdrawnPayload,
  SpecWithdrawResult,
  TimelineEvent,
} from "../src/index.ts";

const actor = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const createdAt = "2026-09-19T12:00:00.000Z";
const version = {
  number: 1,
  author: actor,
  message: null,
  created_at: createdAt,
};
const info = {
  current_version: 1,
  current_version_cursor: "push-cursor",
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [{ path: "design.md", size: 10 }],
  versions: [version],
};
const issue = {
  id: 1,
  number: 428,
  title: "Spec withdrawal",
  body: "",
  status: {
    id: 1,
    name: "Open",
    category: "open",
    color: "#123456",
    position: 0,
    is_default: true,
  },
  author: actor,
  assignees: [],
  labels: [],
  created_at: createdAt,
  updated_at: createdAt,
  body_edited_at: null,
};

describe("SpecWithdrawInput", () => {
  it("accepts an omitted reason and trims a supplied plain-text reason", () => {
    expect(SpecWithdrawInput.parse({ version: 1 })).toEqual({ version: 1 });
    expect(
      SpecWithdrawInput.parse({ version: 2, reason: "  Rework @alice T-42\n" }),
    ).toEqual({ version: 2, reason: "Rework @alice T-42" });
  });

  it.each([undefined, null, 0, -1, 1.5, "1", Number.NaN, Infinity])(
    "rejects an invalid version: %s",
    (value) => {
      expect(SpecWithdrawInput.safeParse({ version: value }).success).toBe(
        false,
      );
    },
  );

  it.each(["", " \t\n", null, 42])(
    "rejects an invalid reason: %s",
    (reason) => {
      expect(SpecWithdrawInput.safeParse({ version: 1, reason }).success).toBe(
        false,
      );
    },
  );

  it("checks the 2000-character limit after trimming using Zod string length", () => {
    const reason = "x".repeat(2000);
    expect(
      SpecWithdrawInput.parse({ version: 1, reason: ` ${reason} ` }).reason,
    ).toBe(reason);
    expect(
      SpecWithdrawInput.safeParse({ version: 1, reason: "x".repeat(2001) })
        .success,
    ).toBe(false);
    const surrogatePair = "\u{1d11e}";
    expect(
      SpecWithdrawInput.safeParse({
        version: 1,
        reason: surrogatePair.repeat(1000),
      }).success,
    ).toBe(true);
    expect(
      SpecWithdrawInput.safeParse({
        version: 1,
        reason: surrogatePair.repeat(1001),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields instead of silently dropping them", () => {
    expect(
      SpecWithdrawInput.safeParse({ version: 1, force: true }).success,
    ).toBe(false);
  });
});

describe("withdrawal responses and events", () => {
  it.each([false, true])(
    "parses unchanged=%s with the withdrawal cursor",
    (unchanged) => {
      const result = {
        version: 1,
        review_status: "withdrawn",
        unchanged,
        cursor: "withdrawal-cursor",
      };
      expect(SpecWithdrawResult.parse(result)).toEqual(result);
      for (const invalid of [
        { version: 0 },
        { version: 1.5 },
        { review_status: "unreviewed" },
        { unchanged: "true" },
        { cursor: "" },
        { cursor: undefined },
      ]) {
        expect(
          SpecWithdrawResult.safeParse({ ...result, ...invalid }).success,
        ).toBe(false);
      }
    },
  );

  it.each([null, "Reworking the design"])(
    "keeps actor and timestamp in the event envelope with reason=%s",
    (reason) => {
      const payload = { version: 1, reason };
      expect(SpecWithdrawnPayload.parse(payload)).toEqual(payload);
      const event = {
        type: "event",
        id: 2,
        event_type: "spec_withdrawn",
        actor,
        payload,
        created_at: createdAt,
        agent_context: null,
      };
      expect(TimelineEvent.parse(event)).toEqual(event);
    },
  );

  it("requires nullable reason and a positive integer version in a strict payload", () => {
    for (const payload of [
      { version: 1 },
      { version: 0, reason: null },
      { version: 1.5, reason: null },
      { version: "1", reason: null },
      { version: 1, reason: 42 },
      { version: 1, reason: null, actor },
      { version: 1, reason: null, created_at: createdAt },
      { version: 1, reason: null, agent_context: null },
    ]) {
      expect(SpecWithdrawnPayload.safeParse(payload).success).toBe(false);
    }
  });
});

describe("spec withdrawal compatibility", () => {
  it("parses old version and spec responses without adding withdrawal metadata", () => {
    expect(SpecVersionInfo.parse(version)).toEqual(version);
    expect(SpecInfo.parse(info)).toEqual(info);
    expect(SpecInfo.parse(info).versions[0]).not.toHaveProperty("withdrawal");
  });

  it.each([null, "Reworking the design"])(
    "parses history with reason=%s",
    (reason) => {
      const withdrawal = { actor, created_at: createdAt, reason };
      const response = {
        ...info,
        review_status: "withdrawn",
        versions: [{ ...version, withdrawal }],
      };
      expect(SpecInfo.parse(response)).toEqual(response);
      for (const invalid of [
        null,
        { ...withdrawal, actor: null },
        { ...withdrawal, created_at: "yesterday" },
        { actor, created_at: createdAt },
      ]) {
        expect(
          SpecVersionInfo.safeParse({ ...version, withdrawal: invalid })
            .success,
        ).toBe(false);
      }
    },
  );

  it("keeps missing and explicit null issue spec state compatible", () => {
    for (const schema of [Issue, IssueListItem]) {
      expect(schema.parse(issue)).toMatchObject({
        spec_version: null,
        spec_review_status: null,
      });
      expect(
        schema.parse({
          ...issue,
          spec_version: null,
          spec_review_status: null,
        }),
      ).toMatchObject({ spec_version: null, spec_review_status: null });
      for (const reviewStatus of SpecReviewStatus.options) {
        expect(
          schema.parse({
            ...issue,
            spec_version: 1,
            spec_review_status: reviewStatus,
          }),
        ).toMatchObject({ spec_version: 1, spec_review_status: reviewStatus });
      }
    }
    expect(SpecReviewStatus.safeParse(null).success).toBe(false);
    expect(SpecInfo.safeParse({ ...info, review_status: null }).success).toBe(
      false,
    );
  });

  it("keeps withdrawal out of the three review verdicts", () => {
    expect(SpecReviewVerdict.options).toEqual([
      "approve",
      "request_changes",
      "comment",
    ]);
    expect(SpecReviewVerdict.safeParse("withdrawn").success).toBe(false);
    expect(
      SpecReviewSubmitInput.safeParse({ version: 1, verdict: "withdrawn" })
        .success,
    ).toBe(false);
  });
});
