import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { Issue, IssueListPage, Status } from "@todou/shared";
import { toast } from "sonner";
import { prependIssue, removeIssue } from "@/api/issues.ts";
import { issuesEntry } from "@/api/issues-cache.ts";
import { api } from "@/api/queries.ts";
import { applyInvalidation } from "@/api/useUserEvents.ts";

export const boardColumnQuery = (slug: string, statusId: number) =>
  queryOptions({
    ...issuesEntry(["issues", slug, { board: statusId }], {
      kind: "page",
      filter: { status: [statusId] },
    }),
    queryFn: () =>
      api.listIssues(slug, {
        status: [statusId],
        limit: 100,
        sort: "updated",
        order: "desc",
      }),
  });

/**
 * Pure cross-column move for optimistic updates (exported for tests):
 * removes the issue from the source page and prepends it to the target
 * with its new status.
 */
export function moveIssue(
  source: IssueListPage | undefined,
  target: IssueListPage | undefined,
  issueNumber: number,
  newStatus: Status,
): { source?: IssueListPage; target?: IssueListPage } {
  const item = source?.items.find((i) => i.number === issueNumber);
  return {
    source: source && removeIssue(source, issueNumber),
    target:
      item && target
        ? prependIssue(target, { ...item, status: newStatus })
        : target,
  };
}

/**
 * What a settled move asks of the project's lists (T-691). A broad refetch
 * here re-read every column of the board, one request each, to learn that two
 * of them changed. A move names only the status, so the row's verdict is the
 * same one the change feed would give it (T-279): the column holding the card
 * refetches, a column it left whose optimistic copy already dropped it does
 * not. Pages that are not on screen are marked stale for their next mount,
 * because the verdict judges a counts entry against the optimistic copy,
 * which already carries the new status.
 *
 * A failed move has no row to judge with, and the rollback may have restored
 * a page that the server moved anyway, so it keeps the broad refetch.
 */
function invalidateAfterMove(
  queryClient: QueryClient,
  slug: string,
  issueNumber: number,
  moved: Issue | undefined,
): void {
  const key = ["issues", slug];
  if (moved === undefined) {
    queryClient.invalidateQueries({ queryKey: key });
    return;
  }
  queryClient.invalidateQueries({
    queryKey: key,
    type: "inactive",
    refetchType: "none",
  });
  applyInvalidation(queryClient, {
    key,
    scope: {
      issueRows: [
        {
          verdict: "fields",
          number: issueNumber,
          row: { kind: "fields", status_id: moved.status.id },
        },
      ],
    },
  });
}

export function useBoardMove() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      slug: string;
      issueNumber: number;
      fromStatusId: number;
      toStatus: Status;
    }) =>
      api.updateIssue(vars.slug, vars.issueNumber, {
        status_id: vars.toStatus.id,
      }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["issues", vars.slug] });
      const fromKey = boardColumnQuery(vars.slug, vars.fromStatusId).queryKey;
      const toKey = boardColumnQuery(vars.slug, vars.toStatus.id).queryKey;
      const snapshot = {
        from: queryClient.getQueryData<IssueListPage>(fromKey),
        to: queryClient.getQueryData<IssueListPage>(toKey),
      };
      const moved = moveIssue(
        snapshot.from,
        snapshot.to,
        vars.issueNumber,
        vars.toStatus,
      );
      if (moved.source) queryClient.setQueryData(fromKey, moved.source);
      if (moved.target) queryClient.setQueryData(toKey, moved.target);
      return { snapshot, fromKey, toKey };
    },
    onError: (error, _vars, context) => {
      if (context) {
        queryClient.setQueryData(context.fromKey, context.snapshot.from);
        queryClient.setQueryData(context.toKey, context.snapshot.to);
      }
      toast.error(`Could not move issue: ${error.message}`);
    },
    onSettled: (data, _error, vars) => {
      invalidateAfterMove(queryClient, vars.slug, vars.issueNumber, data);
      queryClient.invalidateQueries({
        queryKey: ["issue", vars.slug, vars.issueNumber],
      });
      queryClient.invalidateQueries({
        queryKey: ["timeline", vars.slug, vars.issueNumber],
      });
    },
  });
}
