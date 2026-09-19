import type {
  CommentComponent,
  TimelineEvent,
  TimelineItem,
} from "@todou/shared";
import {
  answerRecordOf,
  answersByComment,
  QuestionAnsweredPayload,
  selectHidable,
} from "@todou/shared";
import { describe, expect, it } from "vitest";

const actor = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (
  id: number,
  component: CommentComponent | null = null,
): TimelineItem => ({
  type: "comment",
  id,
  author: actor,
  body: `body ${id}`,
  component,
  created_at: "2026-09-16T12:00:00.000Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const event = (
  id: number,
  event_type: string,
  payload: unknown,
): TimelineEvent =>
  ({
    type: "event",
    id,
    event_type,
    actor,
    payload,
    created_at: "2026-09-16T12:00:00.000Z",
    agent_context: null,
  }) as TimelineEvent;

const answeredEvent = (
  id: number,
  commentId: number,
  via?: "answer" | "hide",
  declined = false,
) =>
  event(id, "question_answered", {
    comment_id: commentId,
    ...(via === undefined ? {} : { via }),
    answers: [
      {
        key: "q1",
        selected: declined ? [] : [{ index: 0, label: "here" }],
        other: null,
        declined,
      },
    ],
  });

const answerCases = [
  { name: "legacy answer", via: undefined, declined: false },
  { name: "legacy decline", via: undefined, declined: true },
  { name: "active answer", via: "answer", declined: false },
  { name: "explicit decline", via: "answer", declined: true },
  { name: "hide settlement", via: "hide", declined: true },
] as const;

describe("QuestionAnsweredPayload", () => {
  it.each(answerCases)(
    "accepts a $name without changing it",
    ({ via, declined }) => {
      const payload = answeredEvent(7, 42, via, declined).payload;
      const parsed = QuestionAnsweredPayload.parse(payload);
      expect(parsed).toEqual({
        comment_id: 42,
        ...(via === undefined ? {} : { via }),
        answers: [
          {
            key: "q1",
            selected: declined ? [] : [{ index: 0, label: "here" }],
            other: null,
            declined,
          },
        ],
      });
      if (via === undefined) expect(parsed).not.toHaveProperty("via");
    },
  );

  it.each([
    { via: "" },
    { via: "other" },
    { via: null },
    { via: false },
    { via: 1 },
    { via: {} },
    { via: [] },
  ])("rejects invalid via $via", ({ via }) => {
    const payload = { ...answeredEvent(7, 42).payload, via };
    expect(QuestionAnsweredPayload.safeParse(payload).success).toBe(false);
    expect(answerRecordOf(event(7, "question_answered", payload))).toBeNull();
  });

  it("still rejects unrelated fields with a valid marker", () => {
    const payload = { ...answeredEvent(7, 42, "answer").payload, extra: true };
    expect(QuestionAnsweredPayload.safeParse(payload).success).toBe(false);
    expect(answerRecordOf(event(7, "question_answered", payload))).toBeNull();
  });
});

describe("answerRecordOf", () => {
  it.each(answerCases)(
    "reads a $name as an answer record",
    ({ via, declined }) => {
      const record = answerRecordOf(answeredEvent(7, 42, via, declined));
      expect(record).toEqual({
        comment_id: 42,
        event_id: 7,
        actor,
        created_at: "2026-09-16T12:00:00.000Z",
        answers: [
          {
            key: "q1",
            selected: declined ? [] : [{ index: 0, label: "here" }],
            other: null,
            declined,
          },
        ],
      });
    },
  );

  it("gives null for a comment item", () => {
    expect(answerRecordOf(comment(42))).toBeNull();
  });

  it("gives null for another event type", () => {
    expect(answerRecordOf(event(7, "status_changed", {}))).toBeNull();
  });

  it("gives null when the payload lacks comment_id", () => {
    expect(
      answerRecordOf(event(7, "question_answered", { answers: [] })),
    ).toBeNull();
  });
});

describe("answersByComment", () => {
  it("merges only the answered comments out of a mixed list", () => {
    const map = answersByComment([
      comment(1),
      answeredEvent(2, 41),
      event(3, "label_added", { label: { name: "bug" } }),
      answeredEvent(4, 42, "answer"),
      answeredEvent(5, 43, "answer", true),
      answeredEvent(6, 44, "hide", true),
      comment(42),
    ]);
    expect([...map.keys()].sort()).toEqual([41, 42, 43, 44]);
    expect(map.has(1)).toBe(false);
    expect(map.get(41)?.event_id).toBe(2);
    expect(map.get(43)?.answers[0]?.declined).toBe(true);
    expect(map.get(44)?.answers[0]?.declined).toBe(true);
    expect(map.get(42)?.event_id).toBe(4);
    expect(map.get(42)?.answers[0]?.key).toBe("q1");
  });

  it.each(answerCases)(
    "does not classify a $name as an open question",
    ({ via, declined }) => {
      const component: CommentComponent = {
        type: "questions",
        questions: [
          {
            key: "q1",
            multiple: false,
            question: "Where?",
            options: [{ label: "here" }, { label: "there" }],
          },
        ],
      };
      const selection = selectHidable(
        [
          comment(1, component),
          comment(42, component),
          answeredEvent(7, 42, via, declined),
        ],
        { by: "all", keep_last: 0 },
        { hidden: true },
      );
      expect(selection.pick).toEqual([42]);
      expect(selection.skip).toEqual([{ id: 1, reason: "open_question" }]);
      expect(selection.crossed).toEqual([]);
    },
  );
});
