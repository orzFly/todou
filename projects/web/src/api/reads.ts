import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/queries.ts";

/**
 * Advance my last-seen position on an issue (#46). Best-effort by design:
 * failures only warn — read state must never block the page, and the next
 * visit retries naturally.
 */
export function useMarkIssueRead(slug: string, number: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.markIssueRead(slug, number, {}),
    onError: (error) => console.warn("mark-read failed", error),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["issues", slug] }),
  });
}
