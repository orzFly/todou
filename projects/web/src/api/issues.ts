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

export const ID_CSV = /^\d+(,\d+)*$/;

/**
 * A param that is textual even when it looks numeric. The router parses the
 * query string before any schema sees it, so `?q=141` — a reader pasting a
 * card number — arrives as the number 141 and a bare `z.string()` throws
 * the whole route away (T-189).
 */
export const textParam = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z.string(),
);

/** URL search params for the list view — shareable filter state. */
export const issueSearchSchema = z.object({
  q: textParam.optional(),
  // "all" is explicit because the absence of the param means "open".
  category: z.enum(["open", "closed", "all"]).optional(),
  status: textParam.refine((v) => ID_CSV.test(v)).optional(),
  label: textParam.refine((v) => ID_CSV.test(v)).optional(),
  assignee: z.coerce.number().int().positive().optional(),
  sort: z.enum(["created", "updated", "number"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  // Grouping is the default, so only the opt-out appears in the URL.
  group: z.enum(["none"]).optional(),
  // The trash (T-145) is a mode of the list route, not a route of its own —
  // so it is one param, and the same URL is shareable with whoever else may
  // see it. Present only when on.
  deleted: z.union([z.literal(true), z.literal(1), z.literal("1")]).optional(),
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

type ListParams = {
  q?: string;
  category?: "open" | "closed";
  status?: number[];
  label?: number[];
  assignee?: number;
  sort?: "created" | "updated" | "number";
  order?: "asc" | "desc";
  deleted?: true;
};

/** URL search state → list API params, with the defaults applied. */
export function listParams(search: IssueSearch): ListParams {
  if (search.deleted) {
    // The trash comes back as one flat set the server orders by deletion
    // time. The category tabs, the status/label/assignee filters and the
    // sort controls all describe live work, so none of them is passed on.
    return { q: search.q, deleted: true };
  }
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

/**
 * What a project is working on right now, for the search box's peek at a
 * project named without a card number (T-263). Open only, because the peek
 * is an invitation to pick up live work rather than a history — and short,
 * because it shares one ten-row panel with everything else on offer.
 */
export const recentOpenIssuesQuery = (slug: string, limit: number) =>
  queryOptions({
    queryKey: ["issue-peek", slug, limit],
    queryFn: () =>
      api.listIssues(slug, {
        category: "open",
        sort: "updated",
        order: "desc",
        limit,
      }),
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

/**
 * Everything a delete or a restore can move: the card itself, every list and
 * count page of the project (the trash is one of them), and the inbox, which
 * a deleted card drops straight out of.
 */
function invalidateAfterTrashMove(
  queryClient: ReturnType<typeof useQueryClient>,
  slug: string,
  issueNumber: number,
): void {
  queryClient.invalidateQueries({ queryKey: ["issues", slug] });
  queryClient.invalidateQueries({ queryKey: ["issue", slug, issueNumber] });
  queryClient.invalidateQueries({ queryKey: ["inbox"] });
  // Every rendered <IssueLink> to this card reads through here, and this is
  // the invalidation that makes them flip to plain text (and back).
  queryClient.invalidateQueries({ queryKey: ["issue-ref", slug] });
}

/** Move an issue to the trash (T-145). */
export function useDeleteIssueMutation(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issueNumber: number) => api.deleteIssue(slug, issueNumber),
    onError: (error) => toast.error(`Could not delete issue: ${error.message}`),
    onSettled: (_data, _error, issueNumber) =>
      invalidateAfterTrashMove(queryClient, slug, issueNumber),
  });
}

export function useRestoreIssueMutation(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issueNumber: number) => api.restoreIssue(slug, issueNumber),
    onError: (error) =>
      toast.error(`Could not restore issue: ${error.message}`),
    onSettled: (_data, _error, issueNumber) =>
      invalidateAfterTrashMove(queryClient, slug, issueNumber),
  });
}

/**
 * What a move would do, without doing it. Keyed on the destination so
 * switching projects in the dialog re-previews rather than showing the
 * previous answer.
 */
export function movePreviewQuery(
  slug: string,
  issueNumber: number,
  toProject: string | null,
) {
  return queryOptions({
    queryKey: ["move-preview", slug, issueNumber, toProject],
    queryFn: () =>
      api.moveIssue(slug, issueNumber, {
        to_project: toProject as string,
        dry_run: true,
      }),
    enabled: toProject !== null,
    // A preview the user is about to act on: never served stale.
    staleTime: 0,
  });
}

/** Move an issue to another project (T-231). */
export function useMoveIssueMutation(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { issueNumber: number; toProject: string }) =>
      api.moveIssue(slug, vars.issueNumber, {
        to_project: vars.toProject,
        dry_run: false,
      }),
    onError: (error) => toast.error(`Could not move issue: ${error.message}`),
    onSettled: (result, _error, vars) => {
      // Both ends move: the card leaves one project's lists and joins the
      // other's, and every <IssueLink> pointing at the old address has to
      // re-resolve before it can find the redirect.
      invalidateAfterTrashMove(queryClient, slug, vars.issueNumber);
      if (result) {
        invalidateAfterTrashMove(
          queryClient,
          result.moved_to.slug,
          result.moved_to.number as number,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["comment-location"] });
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
