import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  IssueCounts,
  IssueListItem,
  IssueListPage,
  Status,
} from "@todou/shared";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/api/queries.ts";

/** URL search params for the list view — shareable filter state. */
export const issueSearchSchema = z.object({
  q: z.string().optional(),
  // "all" is explicit because the absence of the param means "open".
  category: z.enum(["open", "closed", "all"]).optional(),
  status: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .optional(),
  label: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .optional(),
  assignee: z.coerce.number().int().positive().optional(),
  sort: z.enum(["created", "updated", "number"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
export type IssueSearch = z.infer<typeof issueSearchSchema>;

/** GitHub-like defaults: open issues, most recently updated first. */
export function effectiveCategory(
  search: IssueSearch,
): "open" | "closed" | "all" {
  return search.category ?? "open";
}

export function effectiveSort(search: IssueSearch): {
  sort: "created" | "updated" | "number";
  order: "asc" | "desc";
} {
  return { sort: search.sort ?? "updated", order: search.order ?? "desc" };
}

/** URL search state → list API params, with the defaults applied. */
export function listParams(search: IssueSearch) {
  const category = effectiveCategory(search);
  return {
    q: search.q,
    category: category === "all" ? undefined : category,
    status: csvToIds(search.status),
    label: csvToIds(search.label),
    assignee: search.assignee,
    ...effectiveSort(search),
  };
}

export function csvToIds(csv?: string): number[] | undefined {
  if (!csv) return undefined;
  return csv.split(",").map(Number);
}

export function idsToCsv(ids: number[]): string | undefined {
  return ids.length === 0 ? undefined : ids.join(",");
}

export function toggleId(ids: number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export const issuesQuery = (slug: string, search: IssueSearch) =>
  queryOptions({
    queryKey: ["issues", slug, search],
    queryFn: () => api.listIssues(slug, listParams(search)),
  });

/**
 * Keyed under ["issues", slug] on purpose: every existing invalidation of
 * the list (mutations, SSE, reconnect) refreshes the tab counts with it.
 */
export const issueCountsQuery = (slug: string, search: IssueSearch) =>
  queryOptions({
    queryKey: [
      "issues",
      slug,
      "counts",
      {
        q: search.q,
        status: search.status,
        label: search.label,
        assignee: search.assignee,
      },
    ],
    queryFn: () =>
      api.getIssueCounts(slug, {
        q: search.q,
        status: csvToIds(search.status),
        label: csvToIds(search.label),
        assignee: search.assignee,
      }),
  });

export const issueQuery = (slug: string, number: number) =>
  queryOptions({
    queryKey: ["issue", slug, number],
    queryFn: () => api.getIssue(slug, number),
  });

/** Pure cache patch, exported for tests. */
export function patchIssueStatus(
  page: IssueListPage,
  issueNumber: number,
  status: Status,
): IssueListPage {
  return {
    ...page,
    items: page.items.map((item: IssueListItem) =>
      item.number === issueNumber ? { ...item, status } : item,
    ),
  };
}

/** Optimistic inline status change from the list/board views. */
export function useIssueStatusMutation(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { issueNumber: number; status: Status }) =>
      api.updateIssue(slug, vars.issueNumber, { status_id: vars.status.id }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["issues", slug] });
      const snapshots = queryClient.getQueriesData<IssueListPage | IssueCounts>(
        { queryKey: ["issues", slug] },
      );
      for (const [key, data] of snapshots) {
        // The counts query shares the key prefix but has no items to patch.
        if (data && "items" in data) {
          queryClient.setQueryData(
            key,
            patchIssueStatus(data, vars.issueNumber, vars.status),
          );
        }
      }
      return { snapshots };
    },
    onError: (error, _vars, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
      toast.error(`Could not move issue: ${error.message}`);
    },
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: ["issues", slug] });
      queryClient.invalidateQueries({
        queryKey: ["issue", slug, vars.issueNumber],
      });
    },
  });
}

/** Optimistic label toggle from the list view. */
export function useIssueLabelsMutation(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { issueNumber: number; labelIds: number[] }) =>
      api.updateIssue(slug, vars.issueNumber, { label_ids: vars.labelIds }),
    onError: (error) =>
      toast.error(`Could not update labels: ${error.message}`),
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: ["issues", slug] });
      queryClient.invalidateQueries({
        queryKey: ["issue", slug, vars.issueNumber],
      });
    },
  });
}
