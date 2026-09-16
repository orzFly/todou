import { QuestionAnsweredPayload } from "./schemas/component.ts";
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

/**
 * One record per answered comment, keyed by comment id — the only parser of
 * this payload in the repo (`hide-policy.ts` reads the same map's keys).
 */
export function answersByComment(
  items: TimelineItem[],
): Map<number, AnsweredComment> {
  const byComment = new Map<number, AnsweredComment>();
  for (const item of items) {
    const record = answerRecordOf(item);
    if (record !== null && !byComment.has(record.comment_id)) {
      byComment.set(record.comment_id, record);
    }
  }
  return byComment;
}
