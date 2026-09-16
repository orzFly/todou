import type { TimelineItem } from "@todou/shared";
import { answerRecordOf, answersByComment } from "@todou/shared";
import { describe, expect, it } from "vitest";

const actor = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (id: number): TimelineItem => ({
  type: "comment",
  id,
  author: actor,
  body: `body ${id}`,
  component: null,
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
): TimelineItem =>
  ({
    type: "event",
    id,
    event_type,
    actor,
    payload,
    created_at: "2026-09-16T12:00:00.000Z",
    agent_context: null,
  }) as TimelineItem;

const answeredEvent = (id: number, commentId: number) =>
  event(id, "question_answered", {
    comment_id: commentId,
    answers: [
      {
        key: "q1",
        selected: [{ index: 0, label: "here" }],
        other: null,
        declined: false,
      },
    ],
  });

describe("answerRecordOf", () => {
  it("reads the five fields off a question_answered event", () => {
    const record = answerRecordOf(answeredEvent(7, 42));
    expect(record).toEqual({
      comment_id: 42,
      event_id: 7,
      actor,
      created_at: "2026-09-16T12:00:00.000Z",
      answers: [
        {
          key: "q1",
          selected: [{ index: 0, label: "here" }],
          other: null,
          declined: false,
        },
      ],
    });
  });

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
      answeredEvent(4, 42),
      comment(42),
    ]);
    expect([...map.keys()].sort()).toEqual([41, 42]);
    expect(map.get(42)?.event_id).toBe(4);
    expect(map.get(42)?.answers[0]?.key).toBe("q1");
  });
});
