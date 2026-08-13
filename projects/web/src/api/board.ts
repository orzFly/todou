import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { IssueListPage, Status } from "@todou/shared";
import { toast } from "sonner";
import { prependIssue, removeIssue } from "@/api/issues.ts";
import { api } from "@/api/queries.ts";

export const boardColumnQuery = (slug: string, statusId: number) =>
  queryOptions({
    queryKey: ["issues", slug, { board: statusId }],
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

export function useBoardMove(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      issueNumber: number;
      fromStatusId: number;
      toStatus: Status;
    }) =>
      api.updateIssue(slug, vars.issueNumber, {
        status_id: vars.toStatus.id,
      }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["issues", slug] });
      const fromKey = boardColumnQuery(slug, vars.fromStatusId).queryKey;
      const toKey = boardColumnQuery(slug, vars.toStatus.id).queryKey;
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
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: ["issues", slug] });
      queryClient.invalidateQueries({
        queryKey: ["issue", slug, vars.issueNumber],
      });
      queryClient.invalidateQueries({
        queryKey: ["timeline", slug, vars.issueNumber],
      });
    },
  });
}
