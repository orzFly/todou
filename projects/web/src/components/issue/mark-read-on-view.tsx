import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useMarkIssueRead } from "@/api/reads.ts";

/** Batches the SSE-driven trickle of timeline updates into one PUT. */
export const ABSORB_DEBOUNCE_MS = 2_000;

/**
 * Renders nothing; marks the issue read while the user is looking at it.
 * One PUT on mount, then another (debounced) whenever this issue's timeline
 * data refreshes while the tab is visible — so a comment that streams in
 * mid-read doesn't re-light the list dot, while a backgrounded tab never
 * silently swallows unread state. Watches the query cache by key prefix
 * only, staying decoupled from the timeline query's internal shape.
 */
export function MarkReadOnView({
  slug,
  number,
}: {
  slug: string;
  number: number;
}) {
  const queryClient = useQueryClient();
  const { mutate } = useMarkIssueRead(slug, number);

  useEffect(() => {
    mutate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      const key = event.query.queryKey;
      if (key[0] !== "timeline" || key[1] !== slug || key[2] !== number) {
        return;
      }
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      timer = setTimeout(mutate, ABSORB_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [slug, number, mutate, queryClient]);

  return null;
}
