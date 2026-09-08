import { useRevealedRuns } from "@/components/timeline/revealed-runs.tsx";
import {
  RevealLink,
  TimelineRule,
} from "@/components/timeline/timeline-rule.tsx";
import { Separator } from "@/components/ui/separator";

/**
 * The line between the card and its timeline, carrying the card's hidden
 * count and the one `Reveal all` entry (T-281).
 *
 * The line was already here, so writing the count into it costs no new
 * furniture and says the same thing the placeholders say, in the same
 * shape. It handles the reader who has not scrolled yet; the floating
 * title bar mirrors it for every other scroll position.
 *
 * With nothing hidden it falls back to the plain separator — no leftover
 * decoration on a card that never used the feature.
 */
export function TimelineDivider() {
  const { hiddenCount, revealAll } = useRevealedRuns();
  if (hiddenCount === 0) return <Separator />;
  return (
    <TimelineRule data-testid="timeline-divider">
      <span>
        timeline · {hiddenCount} hidden comment{hiddenCount === 1 ? "" : "s"}
      </span>
      <RevealLink label="Reveal all" onClick={revealAll} />
    </TimelineRule>
  );
}
