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
  // Grouping is the default, so only the opt-out appears in the URL.
  group: z.enum(["none"]).optional(),
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

/** Grouping applies only to the open-category view; T-88. */
export function effectiveGroup(search: IssueSearch): "status" | "none" {
  return search.group ?? "status";
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
 * Candidates for the editor's `#`/`T-` completion (T-161): the most recently
 * touched cards of one project, open and closed alike — a ref to a finished
 * card is as legitimate as one to a live card. Cached like the other
 * reference lookups, since completion fires on every keystroke.
 */
export const issueCompletionQuery = (slug: string) =>
  queryOptions({
    queryKey: ["issue-completion", slug],
    queryFn: () =>
      api.listIssues(slug, { sort: "updated", order: "desc", limit: 100 }),
    staleTime: 60_000,
  });

/** Title/body search behind the same completion, for what the window misses. */
export const issueCompletionSearchQuery = (slug: string, q: string) =>
  queryOptions({
    queryKey: ["issue-completion", slug, "search", q],
    queryFn: () =>
      api.listIssues(slug, { q, sort: "updated", order: "desc", limit: 20 }),
    staleTime: 60_000,
  });

/**
 * One status group of the grouped list view (T-88): the group is its own
 * exact-status query, so each group paginates independently, board-style.
 * The URL's multi-status filter only decides which groups render — it is
 * deliberately absent here.
 */
export const issueGroupQuery = (
  slug: string,
  statusId: number,
  search: IssueSearch,
) =>
  queryOptions({
    // The {group} marker keys the cache under the ["issues", slug] prefix
    // (existing SSE/mutation invalidations cover it) and lets the status
    // mutation recognize status-scoped pages.
    queryKey: [
      "issues",
      slug,
      { group: statusId },
      {
        q: search.q,
        label: search.label,
        assignee: search.assignee,
        ...effectiveSort(search),
      },
    ],
    queryFn: () =>
      api.listIssues(slug, {
        status: [statusId],
        q: search.q,
        label: csvToIds(search.label),
        assignee: search.assignee,
        ...effectiveSort(search),
      }),
  });

/**
 * The status id a cached page is scoped to — {board: id} columns and
 * {group: id} list groups — or null for mixed-status (flat) pages.
 * Exported for tests.
 */
export function statusScopeOf(queryKey: readonly unknown[]): number | null {
  const marker = queryKey[2];
  if (typeof marker !== "object" || marker === null) return null;
  const scope =
    (marker as { board?: unknown }).board ??
    (marker as { group?: unknown }).group;
  return typeof scope === "number" ? scope : null;
}

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

/** Pure cache patches for status-scoped pages, exported for tests. */
export function removeIssue(
  page: IssueListPage,
  issueNumber: number,
): IssueListPage {
  return {
    ...page,
    items: page.items.filter((item) => item.number !== issueNumber),
  };
}

export function prependIssue(
  page: IssueListPage,
  item: IssueListItem,
): IssueListPage {
  return { ...page, items: [item, ...page.items] };
}

/**
 * Counts patch for an optimistic status move (exported for tests): the
 * per-status pair shifts by one, and open/closed follow when the move
 * crosses categories. A drained status keeps its 0 entry — the grouped
 * view already treats 0 as "don't render".
 */
export function patchCountsMove(
  counts: IssueCounts,
  from: Status,
  to: Status,
): IssueCounts {
  if (from.id === to.id) return counts;
  const by_status = { ...counts.by_status };
  const fromKey = String(from.id);
  const toKey = String(to.id);
  by_status[fromKey] = Math.max(0, (by_status[fromKey] ?? 0) - 1);
  by_status[toKey] = (by_status[toKey] ?? 0) + 1;
  const next = { ...counts, by_status };
  if (from.category !== to.category) {
    next[from.category] = Math.max(0, next[from.category] - 1);
    next[to.category] += 1;
  }
  return next;
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
      // The pre-move row, from whichever page holds it: its old status
      // drives the counts patch and the source-group removal below.
      let moved: IssueListItem | undefined;
      for (const [, data] of snapshots) {
        if (data && "items" in data) {
          moved = data.items.find((i) => i.number === vars.issueNumber);
          if (moved) break;
        }
      }
      for (const [key, data] of snapshots) {
        if (!data) continue;
        if (!("items" in data)) {
          // Counts page: keep the group headers and segment totals in step.
          if (moved) {
            queryClient.setQueryData(
              key,
              patchCountsMove(data, moved.status, vars.status),
            );
          }
          continue;
        }
        const scope = statusScopeOf(key);
        if (scope === null) {
          // Mixed-status (flat) page: the row stays, only its pill changes.
          queryClient.setQueryData(
            key,
            patchIssueStatus(data, vars.issueNumber, vars.status),
          );
        } else if (scope === vars.status.id && moved) {
          // Target group/column of the move (any cached filter variant).
          if (moved.status.id !== vars.status.id) {
            queryClient.setQueryData(
              key,
              prependIssue(data, { ...moved, status: vars.status }),
            );
          }
        } else if (scope !== vars.status.id) {
          queryClient.setQueryData(key, removeIssue(data, vars.issueNumber));
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
