import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { IssueListPage } from "@todou/shared";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";

/**
 * Read positions are private and eventless — no timeline entry, no SSE, no
 * /activity row — so a mark-read is invisible to every change signal the app
 * has. The mutating client is the only party that knows the inbox shrank, and
 * must say so itself or the badge keeps its old count until something
 * unrelated happens to refresh it (T-112).
 */
const readInvalidations = (
  slug: string,
): ReadonlyArray<ReadonlyArray<unknown>> => [["issues", slug], ["inbox"]];

/**
 * Advance my last-seen position on an issue (T-46). Best-effort by design:
 * failures only warn — read state must never block the page, and the next
 * visit retries naturally.
 */
export function useMarkIssueRead(slug: string, number: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.markIssueRead(slug, number, {}),
    onError: (error) => console.warn("mark-read failed", error),
    onSettled: () => {
      for (const queryKey of readInvalidations(slug)) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

/** Pure cache patch, exported for tests. */
export function clearUnread(
  page: IssueListPage,
  issueNumber: number,
): IssueListPage {
  return {
    ...page,
    items: page.items.map((item) =>
      item.number === issueNumber
        ? { ...item, unread: false, unread_comments: 0 }
        : item,
    ),
  };
}

/**
 * Explicit mark-as-read (T-81), the loud sibling of useMarkIssueRead: the
 * passive on-view path may fail silently, a clicked button may not. Clears
 * the marker optimistically across every cache under ["issues", slug] —
 * list filter pages and board columns share that prefix.
 */
export function useMarkReadAction(slug: string, number: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.markIssueRead(slug, number, {}),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["issues", slug] });
      const snapshot = queryClient.getQueriesData<IssueListPage>({
        queryKey: ["issues", slug],
      });
      for (const [key, data] of snapshot) {
        // The prefix also matches the tab-counts cache (no `items`); leave
        // anything that isn't a list page untouched.
        if (!data || !("items" in data)) continue;
        queryClient.setQueryData(key, clearUnread(data, number));
      }
      return { snapshot };
    },
    onError: (error, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) {
        queryClient.setQueryData(key, data);
      }
      toast.error(`Could not mark as read: ${error.message}`);
    },
    onSettled: () => {
      for (const queryKey of readInvalidations(slug)) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
