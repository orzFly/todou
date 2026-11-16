import type { QuestionSettlement } from "@todou/shared";
import { createContext, useContext } from "react";

/**
 * What the loaded timeline has proven about settlements (T-365): one record
 * per comment the loaded window saw a `question_answered` or
 * `question_withdrawn` event for. The default is the empty map — "the
 * timeline proved nothing" — so a card mounted outside a timeline (tests,
 * future surfaces) falls back to `/questions`.
 */
const TimelineSettlements = createContext<Map<number, QuestionSettlement>>(
  new Map(),
);

export function TimelineSettlementsProvider({
  settlements,
  children,
}: {
  settlements: Map<number, QuestionSettlement>;
  children: React.ReactNode;
}) {
  return (
    <TimelineSettlements.Provider value={settlements}>
      {children}
    </TimelineSettlements.Provider>
  );
}

/**
 * The settlement the loaded timeline holds for one comment, or null when the
 * timeline proves nothing either way — pagination may have left the event
 * in an unloaded gap, which only `/questions` can settle.
 */
export function useTimelineSettlement(
  commentId: number,
): QuestionSettlement | null {
  return useContext(TimelineSettlements).get(commentId) ?? null;
}
