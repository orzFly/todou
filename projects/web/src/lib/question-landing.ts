import type { IssueQuestions } from "@todou/shared";

export const UNANSWERED_QUESTIONS_HASH = "unanswered-questions";

export function isQuestionLandingHash(hash: string): boolean {
  return hash.replace(/^#/, "") === UNANSWERED_QUESTIONS_HASH;
}

/** Questions arrive in created_at, comment_id order; answers do not reorder them. */
export function selectQuestionLanding({
  items,
}: IssueQuestions): number | null {
  return (
    items.find((item) => item.answer === null)?.comment_id ??
    items.at(-1)?.comment_id ??
    null
  );
}
