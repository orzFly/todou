import type { AnsweredComment } from "@todou/shared";
import { createContext, useContext } from "react";

/**
 * What the loaded timeline has proven about answers (T-365): one record per
 * comment the loaded window saw a `question_answered` event for. The default
 * is the empty map — "the timeline proved nothing" — so a card mounted
 * outside a timeline (tests, future surfaces) falls back to `/questions`.
 */
const TimelineAnswers = createContext<Map<number, AnsweredComment>>(new Map());

export function TimelineAnswersProvider({
  answers,
  children,
}: {
  answers: Map<number, AnsweredComment>;
  children: React.ReactNode;
}) {
  return (
    <TimelineAnswers.Provider value={answers}>
      {children}
    </TimelineAnswers.Provider>
  );
}

/**
 * The answer the loaded timeline holds for one comment, or null when the
 * timeline proves nothing either way — pagination may have left the event
 * in an unloaded gap, which only `/questions` can settle.
 */
export function useTimelineAnswer(commentId: number): AnsweredComment | null {
  return useContext(TimelineAnswers).get(commentId) ?? null;
}
