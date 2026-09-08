import {
  RevealLink,
  TimelineRule,
} from "@/components/timeline/timeline-rule.tsx";

/**
 * A run of hidden comments (T-281): one thin rule with the count in it, and
 * a link that opens the run for this page only.
 *
 * Deliberately the lightest of the three shapes drawn for it — it reads as a
 * gap rather than a block, so a card carrying seven or eight runs does not
 * become a timeline chopped into slabs. `FoldBlock` is the other kind of
 * collapse and stays a bordered block on purpose: the two can appear on one
 * timeline and must not be mistaken for each other.
 *
 * Revealing is one-way. This draws a line above the run and none below it,
 * so there is no boundary a "hide it again" control could point at;
 * reloading brings the gaps back, since no entry here writes anything.
 */
export function HiddenBlock({
  count,
  onReveal,
}: {
  count: number;
  onReveal: () => void;
}) {
  return (
    <TimelineRule className="my-1" data-testid="hidden-block">
      <span>
        {count} hidden comment{count === 1 ? "" : "s"}
      </span>
      <RevealLink label="Reveal" onClick={onReveal} />
    </TimelineRule>
  );
}
