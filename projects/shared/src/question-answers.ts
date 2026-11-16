import {
  QuestionAnsweredPayload,
  QuestionWithdrawnPayload,
} from "./schemas/component.ts";
import type { TimelineEvent, TimelineItem } from "./schemas/timeline.ts";
import type { UserRef } from "./schemas/user.ts";

/**
 * The answers one comment received, in the shape every renderer of an
 * answered card consumes: this is field-for-field the `answer` of
 * `GET /questions` (T-365), so a card fed from the timeline and one fed
 * from that request share one rendering path.
 *
 * The `actor`/`created_at` come from the event itself — a payload only
 * knows which comment and what was answered.
 */
export type AnsweredComment = {
  comment_id: number;
  event_id: number;
  actor: UserRef;
  created_at: string;
  answers: QuestionAnsweredPayload["answers"];
};

/** Field-for-field `GET /questions`' `withdrawal`, plus the comment id. */
export type WithdrawnComment = {
  comment_id: number;
  event_id: number;
  actor: UserRef;
  created_at: string;
  reason: string | null;
};

/**
 * How a question comment was settled. A comment is settled once, so it has
 * at most one of these: every reader that asks "is this still open?" asks
 * this type, which is what keeps a withdrawal from reading as unanswered.
 */
export type QuestionSettlement =
  | { kind: "answered"; answer: AnsweredComment }
  | { kind: "withdrawn"; withdrawal: WithdrawnComment };

/** Turn a `question_answered` event into a record; anything else is `null`. */
export function answerRecordOf(item: TimelineItem): AnsweredComment | null {
  const event = item as TimelineEvent;
  if (event.type !== "event" || event.event_type !== "question_answered") {
    return null;
  }
  const parsed = QuestionAnsweredPayload.safeParse(event.payload);
  if (!parsed.success) return null;
  return {
    comment_id: parsed.data.comment_id,
    event_id: event.id,
    actor: event.actor,
    created_at: event.created_at,
    answers: parsed.data.answers,
  };
}

/** A `question_withdrawn` event as a record; anything else is `null`. */
export function withdrawalRecordOf(
  item: TimelineItem,
): WithdrawnComment | null {
  const event = item as TimelineEvent;
  if (event.type !== "event" || event.event_type !== "question_withdrawn") {
    return null;
  }
  const parsed = QuestionWithdrawnPayload.safeParse(event.payload);
  if (!parsed.success) return null;
  return {
    comment_id: parsed.data.comment_id,
    event_id: event.id,
    actor: event.actor,
    created_at: event.created_at,
    reason: parsed.data.reason,
  };
}

/**
 * One settlement per comment, keyed by comment id, the first event seen
 * winning — the only parser of these payloads in the repo (`hide-policy.ts`
 * reads the same map's keys).
 */
export function settlementsByComment(
  items: TimelineItem[],
): Map<number, QuestionSettlement> {
  const byComment = new Map<number, QuestionSettlement>();
  for (const item of items) {
    const answer = answerRecordOf(item);
    const withdrawal = answer === null ? withdrawalRecordOf(item) : null;
    const settlement: QuestionSettlement | null =
      answer !== null
        ? { kind: "answered", answer }
        : withdrawal !== null
          ? { kind: "withdrawn", withdrawal }
          : null;
    if (settlement === null) continue;
    const commentId =
      settlement.kind === "answered"
        ? settlement.answer.comment_id
        : settlement.withdrawal.comment_id;
    if (!byComment.has(commentId)) byComment.set(commentId, settlement);
  }
  return byComment;
}
