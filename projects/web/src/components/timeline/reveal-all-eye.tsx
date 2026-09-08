import { EyeIcon } from "lucide-react";
import { useRevealedRuns } from "@/components/timeline/revealed-runs.tsx";

/**
 * `Reveal all` where it is reachable from any scroll position (T-281): the
 * floating title bar's right edge, as an icon and a count.
 *
 * An icon and not a phrase because that bar is 2.5rem tall and already
 * truncates the title — width is the only constraint there.
 *
 * The eye is the plain one. The crossed-out eye means one thing wherever it
 * appears — "this comment is hidden, put it back" — and that one writes to
 * the server, while this only opens the gaps on this page.
 */
export function RevealAllEye() {
  const { hiddenCount, revealAll } = useRevealedRuns();
  if (hiddenCount === 0) return null;
  return (
    <button
      type="button"
      data-testid="reveal-all-eye"
      title={`Reveal ${hiddenCount} hidden comment${hiddenCount === 1 ? "" : "s"}`}
      className="flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
      onClick={(event) => {
        // The whole bar scrolls the page to the top when clicked, and
        // revealing a run is not a request to leave where you are.
        event.stopPropagation();
        revealAll();
      }}
    >
      <EyeIcon className="size-3.5" />
      <span className="text-xs">{hiddenCount}</span>
    </button>
  );
}
