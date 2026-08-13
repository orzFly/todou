import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { SpecCommentComponent } from "./spec.ts";
import { UserRef } from "./user.ts";

// Everything here is strictObject on purpose: agents hallucinate extra
// fields, and a silently-dropped "optoins" is a debugging session. Unknown
// keys must fail loudly, with the offending path in the message (T-19).

/** Key referenced by answers; short so it survives being typed by hand. */
export const QuestionKey = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/,
    "keys are 1-32 chars: letters, digits, _ or - (must not start with _ or -)",
  );
export type QuestionKey = z.infer<typeof QuestionKey>;

export const QuestionOption = z.strictObject({
  /** Markdown. */
  label: z.string().min(1).max(500),
  /** Markdown. */
  description: z.string().min(1).max(2000).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

const questionShape = {
  header: z.string().min(1).max(200).optional(),
  /** Markdown. */
  question: z.string().min(1).max(8000),
  options: z.array(QuestionOption).min(2).max(12),
};

/** Input form: key optional (the server fills q1…qN), multiple defaults. */
export const QuestionInput = z.strictObject({
  key: QuestionKey.optional(),
  multiple: z.boolean().default(false),
  ...questionShape,
});
export type QuestionInput = z.infer<typeof QuestionInput>;

/** Canonical stored form: key and multiple are always present. */
export const Question = z.strictObject({
  key: QuestionKey,
  multiple: z.boolean(),
  ...questionShape,
});
export type Question = z.infer<typeof Question>;

/** What `todou comment add --questions <file>` contains: just the array. */
export const QuestionsInput = z.array(QuestionInput).min(1).max(10);
export type QuestionsInput = z.infer<typeof QuestionsInput>;

export const QuestionsComponentInput = z.strictObject({
  type: z.literal("questions"),
  questions: QuestionsInput,
});
export type QuestionsComponentInput = z.infer<typeof QuestionsComponentInput>;

export const QuestionsComponent = z.strictObject({
  type: z.literal("questions"),
  questions: z.array(Question).min(1).max(10),
});
export type QuestionsComponent = z.infer<typeof QuestionsComponent>;

/**
 * The extensible slot on comments. Immutable once created — that is what
 * freezes answered questions without any block-level edit rules. Future
 * members (e.g. spec documents, T-23) extend the union.
 */
export const CommentComponentInput = z.discriminatedUnion("type", [
  QuestionsComponentInput,
]);
export type CommentComponentInput = z.infer<typeof CommentComponentInput>;

// Spec comments (T-23) are stored-only on purpose: they exist in the stored
// union but not in the input union, because their anchors must be validated
// and quoted against a stored spec version — they are born exclusively
// inside a review submission, never through a plain comment POST.
export const CommentComponent = z.discriminatedUnion("type", [
  QuestionsComponent,
  SpecCommentComponent,
]);
export type CommentComponent = z.infer<typeof CommentComponent>;

// — answers —

/** Client-side submission for one question; `selected` holds option indexes. */
export const QuestionAnswerInput = z.strictObject({
  key: QuestionKey,
  selected: z.array(z.number().int().nonnegative()).max(12).default([]),
  /** Markdown; free text that may accompany selections or a decline. */
  other: z.string().min(1).max(8000).optional(),
  declined: z.boolean().default(false),
});
export type QuestionAnswerInput = z.infer<typeof QuestionAnswerInput>;

/** One atomic submission covering every question of the comment. */
export const AnswersSubmitInput = z.strictObject({
  answers: z.array(QuestionAnswerInput).min(1).max(10),
});
export type AnswersSubmitInput = z.infer<typeof AnswersSubmitInput>;

/**
 * Stored form of one selection. The index is authoritative (components are
 * immutable, so it can never dangle); the label is a snapshot for humans
 * reading raw events.
 */
export const AnswerSelection = z.strictObject({
  index: z.number().int().nonnegative(),
  label: z.string(),
});
export type AnswerSelection = z.infer<typeof AnswerSelection>;

export const QuestionAnswer = z.strictObject({
  key: QuestionKey,
  selected: z.array(AnswerSelection),
  other: z.string().nullable(),
  declined: z.boolean(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

/** Payload of the `question_answered` timeline event. */
export const QuestionAnsweredPayload = z.strictObject({
  comment_id: Id,
  answers: z.array(QuestionAnswer),
});
export type QuestionAnsweredPayload = z.infer<typeof QuestionAnsweredPayload>;

// — per-issue question status (GET …/issues/:n/questions) —

export const IssueQuestionsItem = z.object({
  comment_id: Id,
  author: UserRef,
  created_at: Timestamp,
  questions: z.array(Question),
  answer: z
    .object({
      event_id: Id,
      actor: UserRef,
      created_at: Timestamp,
      answers: z.array(QuestionAnswer),
    })
    .nullable(),
});
export type IssueQuestionsItem = z.infer<typeof IssueQuestionsItem>;

export const IssueQuestions = z.object({
  items: z.array(IssueQuestionsItem),
  /** Unanswered question count — matches `issues.open_questions` (T-46). */
  open: z.number().int().nonnegative(),
});
export type IssueQuestions = z.infer<typeof IssueQuestions>;
