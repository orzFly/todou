import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { IssueListPage, Status } from "@todou/shared";
import { toast } from "sonner";
import { prependIssue, removeIssue } from "@/api/issues.ts";
import { issuesEntry } from "@/api/issues-cache.ts";
import { api } from "@/api/queries.ts";
import {
  beginRuntimeWrite,
  pageResource as resource,
  runtimeQueryOptions,
  settleRuntimeWrite,
  writeRuntimeData,
} from "@/api/runtime/query-adapter.ts";

export const boardColumnQuery = (slug: string, statusId: number) =>
  runtimeQueryOptions(
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
    }),
    {
      kind: "list",
      resources: [
        resource("issues", `/projects/${slug}/issues`, {
          status: [statusId],
          limit: 100,
          sort: "updated",
          order: "desc",
        }),
      ],
    },
  );

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
      const ownerToken = beginRuntimeWrite(queryClient, {
        queryKey: ["issues", vars.slug],
      });
      try {
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
        if (moved.source)
          writeRuntimeData(queryClient, fromKey, moved.source, ownerToken);
        if (moved.target)
          writeRuntimeData(queryClient, toKey, moved.target, ownerToken);
        return { snapshot, fromKey, toKey, ownerToken };
      } catch (error) {
        await settleRuntimeWrite(queryClient, ownerToken).catch(() => {});
        throw error;
      }
    },
    onError: (error, _vars, context) => {
      if (context) {
        writeRuntimeData(
          queryClient,
          context.fromKey,
          context.snapshot.from,
          context.ownerToken,
        );
        writeRuntimeData(
          queryClient,
          context.toKey,
          context.snapshot.to,
          context.ownerToken,
        );
      }
      toast.error(`Could not move issue: ${error.message}`);
    },
    onSettled: async (_data, _error, vars, context) => {
      if (context)
        await settleRuntimeWrite(queryClient, context.ownerToken).catch(
          () => {},
        );
      queryClient.invalidateQueries({ queryKey: ["issues", vars.slug] });
      queryClient.invalidateQueries({
        queryKey: ["issue", vars.slug, vars.issueNumber],
      });
      queryClient.invalidateQueries({
        queryKey: ["timeline", vars.slug, vars.issueNumber],
      });
    },
  });
}
