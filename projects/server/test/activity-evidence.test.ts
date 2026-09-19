import { PGlite } from "@electric-sql/pglite";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityActorPredicate,
  activityCommentEvidence,
  activityEventPredicate,
  activityMalformedEventPredicate,
  activityRevisionEvidence,
} from "../src/services/activity-calendar/evidence.ts";

let db: PGlite;
const dialect = new PgDialect();
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
});
afterAll(async () => {
  await db?.close();
});

async function evaluate(predicate: SQL): Promise<boolean> {
  const query = dialect.sqlToQuery(sql`SELECT ${predicate} AS allowed`);
  const result = await db.query<{ allowed: boolean }>(query.sql, query.params);
  return result.rows[0].allowed;
}

const answer = {
  key: "q1",
  selected: [{ index: 0, label: "Proceed" }],
  other: null,
  declined: false,
};
const decline = { key: "q1", selected: [], other: null, declined: true };
const from = { id: 1, name: "Open" };
const to = { id: 2, name: "Done" };
const edge = {
  edge_id: 4,
  role: "blocked",
  other_project_id: 3,
  other_number: 7,
};

// Expected answers are deliberately literal and independent of the allowlist.
const cases: [string, string, unknown, boolean][] = [
  ["creation", "opened", {}, true],
  ["close", "closed", { from, to }, true],
  ["reopen", "reopened", { from: to, to: from }, true],
  ["status change", "status_changed", { from, to }, true],
  [
    "missing previous status supported by writer",
    "status_changed",
    { from: null, to },
    true,
  ],
  ["title", "title_changed", { from: "Before", to: "After" }, true],
  [
    "label",
    "label_added",
    { label: { id: 1, name: "area", color: "abcdef" } },
    true,
  ],
  ["label writer id-only fallback", "label_added", { label: { id: 1 } }, true],
  [
    "remove label",
    "label_removed",
    { label: { id: 1, name: "area", color: "abcdef" } },
    true,
  ],
  ["assign", "assigned", { user: { id: 5, login: "bot-one" } }, true],
  [
    "unassign ghost snapshot",
    "unassigned",
    { user: { id: 5, login: "ghost" } },
    true,
  ],
  [
    "completed attachment",
    "attachment_added",
    { attachment: { id: 2, filename: "empty.txt", size: 0 } },
    true,
  ],
  [
    "old selected answer",
    "question_answered",
    { comment_id: 99, answers: [answer] },
    true,
  ],
  [
    "old text answer",
    "question_answered",
    {
      comment_id: 99,
      answers: [{ ...answer, selected: [], other: "Proceed" }],
    },
    true,
  ],
  [
    "old all declined",
    "question_answered",
    { comment_id: 99, answers: [decline] },
    false,
  ],
  [
    "old mixed answers",
    "question_answered",
    { comment_id: 99, answers: [decline, { ...answer, key: "q2" }] },
    true,
  ],
  [
    "new explicit answer",
    "question_answered",
    { comment_id: 99, answers: [answer], via: "answer" },
    true,
  ],
  [
    "new explicit decline",
    "question_answered",
    { comment_id: 99, answers: [decline], via: "answer" },
    true,
  ],
  [
    "hide automatic decline",
    "question_answered",
    { comment_id: 99, answers: [decline], via: "hide" },
    false,
  ],
  [
    "hide with selection is still excluded",
    "question_answered",
    { comment_id: 99, answers: [answer], via: "hide" },
    false,
  ],
  [
    "spec push",
    "spec_pushed",
    {
      version: 1,
      message: null,
      added: ["design.md"],
      changed: [],
      removed: [],
    },
    true,
  ],
  [
    "spec approval without surviving comment",
    "spec_review",
    { version: 1, verdict: "approve", comment_id: null, annotation_count: 0 },
    true,
  ],
  [
    "spec changes",
    "spec_review",
    {
      version: 2,
      verdict: "request_changes",
      comment_id: 99,
      annotation_count: 1,
    },
    true,
  ],
  [
    "spec discussion",
    "spec_review",
    { version: 2, verdict: "comment", comment_id: 99, annotation_count: 0 },
    true,
  ],
  [
    "old resolved spec annotations",
    "spec_comments_resolved",
    { comment_ids: [99] },
    true,
  ],
  [
    "resolved spec paths",
    "spec_comments_resolved",
    { comment_ids: [99], paths: ["design.md"] },
    true,
  ],
  [
    "hidden spec annotations",
    "spec_comments_resolved",
    { comment_ids: [99], via: "hide" },
    false,
  ],
  ["blocked endpoint", "block_added", edge, true],
  ["blocker endpoint", "block_removed", { ...edge, role: "blocker" }, true],
  ["new kinds excluded", "future_event", {}, false],
  ["reference", "referenced", {}, false],
  ["cross reference", "cross_referenced", {}, false],
  ["automatic clear", "block_cleared", edge, false],
  ["automatic reblock", "block_reblocked", edge, false],
  ["delete", "deleted", {}, false],
  ["restore", "restored", {}, false],
  ["move in", "moved_in", {}, false],
  ["move out", "moved_out", {}, false],
  ["read marker", "read", {}, false],
  [
    "SSE pointer is not evidence",
    "updated",
    { updated_at: "2026-09-01T00:00:00Z" },
    false,
  ],
  ["comment hiding", "comment_hidden", {}, false],
  ["metadata", "metadata_changed", {}, false],
  ["unchanged title", "title_changed", { from: "same", to: "same" }, false],
  ["missing title source", "title_changed", { to: "After" }, false],
  ["empty title", "title_changed", { from: "Before", to: "" }, false],
  [
    "same status id despite name change",
    "closed",
    { from, to: { ...from, name: "Renamed" } },
    false,
  ],
  [
    "empty status conversion",
    "status_changed",
    { from: null, to: null },
    false,
  ],
  ["missing status source", "status_changed", { to }, false],
  ["invalid label id", "label_added", { label: { id: "1" } }, false],
  ["invalid user", "assigned", { user: { id: 1 } }, false],
  [
    "invalid attachment",
    "attachment_added",
    { attachment: { id: 2, filename: "a", size: -1 } },
    false,
  ],
  [
    "empty spec push",
    "spec_pushed",
    { version: 1, message: null, added: [], changed: [], removed: [] },
    false,
  ],
  [
    "bad spec arrays",
    "spec_pushed",
    { version: 1, message: null, added: {}, changed: [], removed: [] },
    false,
  ],
  [
    "bad spec verdict",
    "spec_review",
    { version: 1, verdict: "unknown", comment_id: null, annotation_count: 0 },
    false,
  ],
  ["empty resolutions", "spec_comments_resolved", { comment_ids: [] }, false],
  ["bad relation role", "block_added", { ...edge, role: "unknown" }, false],
  [
    "bad relation identity",
    "block_removed",
    { ...edge, other_number: null },
    false,
  ],
  [
    "empty answers",
    "question_answered",
    { comment_id: 99, answers: [], via: "answer" },
    false,
  ],
  [
    "invalid answer array",
    "question_answered",
    { comment_id: 99, answers: {}, via: "answer" },
    false,
  ],
  [
    "input shape is not stored selection shape",
    "question_answered",
    { comment_id: 99, answers: [{ ...answer, selected: [0] }] },
    false,
  ],
  [
    "invalid selected array",
    "question_answered",
    { comment_id: 99, answers: [{ ...answer, selected: {} }] },
    false,
  ],
  [
    "invalid selection index",
    "question_answered",
    {
      comment_id: 99,
      answers: [{ ...answer, selected: [{ index: "0", label: "x" }] }],
    },
    false,
  ],
  [
    "decline cannot select",
    "question_answered",
    { comment_id: 99, answers: [{ ...answer, declined: true }], via: "answer" },
    false,
  ],
  [
    "empty non-decline",
    "question_answered",
    {
      comment_id: 99,
      answers: [{ ...decline, declined: false }],
      via: "answer",
    },
    false,
  ],
  [
    "invalid key",
    "question_answered",
    { comment_id: 99, answers: [{ ...answer, key: "_bad" }] },
    false,
  ],
  [
    "unknown marker",
    "question_answered",
    { comment_id: 99, answers: [answer], via: "future" },
    false,
  ],
  [
    "null marker is not absent",
    "question_answered",
    { comment_id: 99, answers: [answer], via: null },
    false,
  ],
  [
    "strict payload",
    "question_answered",
    { comment_id: 99, answers: [answer], surprise: true },
    false,
  ],
  [
    "strict answer",
    "question_answered",
    { comment_id: 99, answers: [{ ...answer, surprise: true }] },
    false,
  ],
  ["non-object payload", "opened", [], false],
  ["null payload", "opened", null, false],
];

describe("activity evidence SQL", () => {
  it.each(cases)("%s", async (_name, type, payload, expected) => {
    expect(
      await evaluate(
        activityEventPredicate({
          type: sql`${type}::text`,
          payload: sql`${JSON.stringify(payload)}::jsonb`,
        }),
      ),
    ).toBe(expected);
  });

  it.each([
    [
      "hidden question",
      "question_answered",
      { comment_id: 99, answers: [decline], via: "hide" },
      false,
    ],
    [
      "legacy decline",
      "question_answered",
      { comment_id: 99, answers: [decline] },
      false,
    ],
    [
      "hidden spec resolution",
      "spec_comments_resolved",
      { comment_ids: [99], via: "hide" },
      false,
    ],
    ["same title", "title_changed", { from: "same", to: "same" }, false],
    ["same status", "status_changed", { from, to: from }, false],
    [
      "empty spec diff",
      "spec_pushed",
      { version: 1, message: null, added: [], changed: [], removed: [] },
      false,
    ],
    [
      "empty spec resolution",
      "spec_comments_resolved",
      { comment_ids: [] },
      false,
    ],
    ["unallowlisted", "future_event", null, false],
    ["invalid allowed payload", "opened", null, true],
    [
      "invalid question marker",
      "question_answered",
      { comment_id: 99, answers: [answer], via: "unknown" },
      true,
    ],
    [
      "invalid stored answer",
      "question_answered",
      { comment_id: 99, answers: [{ ...answer, selected: [0] }] },
      true,
    ],
    ["invalid title", "title_changed", { to: "After" }, true],
    [
      "invalid spec array",
      "spec_pushed",
      { version: 1, message: null, added: {}, changed: [], removed: [] },
      true,
    ],
    [
      "invalid spec marker",
      "spec_comments_resolved",
      { comment_ids: [99], via: "unknown" },
      true,
    ],
  ] as [string, string, unknown, boolean][])(
    "diagnostics distinguish %s",
    async (_name, type, payload, expected) => {
      expect(
        await evaluate(
          activityMalformedEventPredicate({
            type: sql`${type}::text`,
            payload: sql`${JSON.stringify(payload)}::jsonb`,
          }),
        ),
      ).toBe(expected);
    },
  );

  it("uses creator for comments and editor for revisions, never a machine owner", async () => {
    const comment = activityCommentEvidence({
      id: sql`10`,
      issueId: sql`7`,
      authorId: sql`21`,
      createdAt: sql`'2026-09-01T00:00:00.000001Z'::timestamptz`,
    });
    const revision = activityRevisionEvidence(
      {
        id: sql`40`,
        subjectType: sql`'comment'`,
        subjectId: sql`10`,
        actorId: sql`22`,
        createdAt: sql`'2026-09-02T00:00:00.000002Z'::timestamptz`,
      },
      { issueId: sql`7`, commentId: comment.id },
    );
    expect(await evaluate(activityActorPredicate(comment.actorId, 21))).toBe(
      true,
    );
    expect(await evaluate(activityActorPredicate(comment.actorId, 22))).toBe(
      false,
    );
    expect(await evaluate(activityActorPredicate(revision.actorId, 22))).toBe(
      true,
    );
    expect(await evaluate(activityActorPredicate(revision.actorId, 21))).toBe(
      false,
    );
    expect(await evaluate(activityActorPredicate(revision.actorId, 23))).toBe(
      false,
    );
    expect(await evaluate(activityActorPredicate(revision.actorId))).toBe(true);
    expect(await evaluate(revision.predicate)).toBe(true);
    expect(
      await evaluate(sql`${revision.occurredAt} > ${comment.occurredAt}`),
    ).toBe(true);
  });

  it.each([
    ["issue_body", 7, undefined, true],
    ["issue_body", 8, undefined, false],
    ["comment", 10, 10, true],
    ["comment", 10, 11, false],
    ["comment", 10, undefined, false],
    ["future_subject", 7, 10, false],
  ] as const)(
    "maps %s/%s with extant comment %s",
    async (subjectType, subjectId, commentId, expected) => {
      const revision = activityRevisionEvidence(
        {
          id: sql`40`,
          subjectType: sql`${subjectType}::text`,
          subjectId: sql`${subjectId}::bigint`,
          actorId: sql`22`,
          createdAt: sql`now()`,
        },
        {
          issueId: sql`7`,
          commentId:
            commentId === undefined ? undefined : sql`${commentId}::bigint`,
        },
      );
      expect(await evaluate(sql`COALESCE(${revision.predicate}, false)`)).toBe(
        expected,
      );
    },
  );
});
