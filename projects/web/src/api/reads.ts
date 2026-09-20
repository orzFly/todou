import {
  hashKey,
  type QueryClient,
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { InboxPage, IssueListPage } from "@todou/shared";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import {
  beginRuntimeWrite,
  getRuntimeQueryAdapter,
  settleRuntimeWrite,
  writeRuntimeData,
} from "@/api/runtime/query-adapter.ts";
import {
  type ReadMutationScope,
  readMutationAffects,
} from "@/api/runtime/read-scope.ts";

/** Refresh only cached rows that a read position can change. The transport's
 * mutation registry independently sends this scope to the worker, including
 * when this page has never instantiated any matching query.
 */
export async function invalidateReadQueries(
  queryClient: QueryClient,
  scope: ReadMutationScope,
  optimisticKeys: readonly QueryKey[] = [],
): Promise<void> {
  const keys = new Set(optimisticKeys.map((key) => hashKey(key)));
  const filters = {
    predicate: (query: { queryKey: QueryKey; state: { data: unknown } }) =>
      keys.has(hashKey(query.queryKey)) ||
      readMutationAffects(query.queryKey, query.state.data, scope),
  };
  const adapter = getRuntimeQueryAdapter(queryClient);
  let pending: Promise<void> | undefined;
  if (adapter?.bridge.mode === "worker") {
    // The transport already sent the business scope. Repeating it through
    // page predicates would cancel the repair shared with other pages.
    adapter.pageInvalidation(() => {
      pending = queryClient.invalidateQueries(filters);
    });
  } else {
    pending = queryClient.invalidateQueries(filters);
  }
  await pending;
}

/** What a single-issue mark-read was aimed at, fixed at its `mutate()` call. */
export type ReadTarget = { slug: string; number: number };

/** The bulk sweep's scope; an absent slug is every project. */
export type BulkReadTarget = { slug: string | undefined };

/**
 * Advance my last-seen position on an issue (T-46). Best-effort by design:
 * failures only warn — read state must never block the page, and the next
 * visit retries naturally.
 */
export function useMarkIssueRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: ReadTarget) =>
      api.markIssueRead(vars.slug, vars.number, {}),
    onError: (error) => console.warn("mark-read failed", error),
    onSettled: (_data, _error, vars) =>
      invalidateReadQueries(queryClient, vars).catch(() => {}),
  });
}

/** Pure cache patch, exported for tests. */
export function clearAllUnread(page: IssueListPage): IssueListPage {
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      unread: false,
      unread_comments: 0,
    })),
  };
}

/**
 * The inbox after a sweep, exported for tests. Mirrors the server's
 * keep-check: being read retires only the unread reason, so a row still
 * waiting on my spec review or carrying open questions stays — it just
 * loses its marker. Rows that had nothing else to say leave.
 *
 * `unread_counts` counts all attention rows, including those other reasons,
 * before the per-project limit. Subtract only rows we actually remove:
 * unreturned rows may still need review, so their contribution stays until
 * the authoritative refetch. For a complete project this leaves its exact
 * survivor count; a trimmed project's optimistic count is an upper bound.
 */
export function clearInboxUnread(page: InboxPage, slug?: string): InboxPage {
  const counts = { ...page.unread_counts };
  const items = page.items.flatMap((item) => {
    if (slug !== undefined && item.project.slug !== slug) return [item];
    if (!item.pending_spec_review && item.open_questions === 0) {
      const project = item.project.slug;
      const count = counts[project];
      if (count !== undefined) {
        if (count <= 1) delete counts[project];
        else counts[project] = count - 1;
      }
      return [];
    }
    return [
      { ...item, unread: false, unread_comments: 0, mentions_you: false },
    ];
  });
  return { ...page, items, unread_counts: counts };
}

/**
 * Mark a whole project read, or every project when `slug` is omitted
 * (T-100) — one endpoint, two scopes. Patches the same caches the
 * single-issue action does, plus the inbox itself: without it the page
 * would keep rendering rows the sweep just emptied until the refetch
 * lands.
 */
export function useMarkAllReadAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: BulkReadTarget) =>
      api.markAllRead(vars.slug === undefined ? {} : { projects: [vars.slug] }),
    onMutate: async (vars: BulkReadTarget) => {
      const filters = {
        predicate: (query: { queryKey: QueryKey; state: { data: unknown } }) =>
          readMutationAffects(query.queryKey, query.state.data, vars),
      };
      const ownerToken = beginRuntimeWrite(queryClient, filters);
      try {
        await queryClient.cancelQueries(filters);
        const snapshot = queryClient.getQueriesData<IssueListPage | InboxPage>(
          filters,
        );
        for (const [key, data] of snapshot) {
          if (!data || !("items" in data)) continue;
          writeRuntimeData(
            queryClient,
            key,
            key[0] === "inbox"
              ? clearInboxUnread(data as InboxPage, vars.slug)
              : clearAllUnread(data as IssueListPage),
            ownerToken,
          );
        }
        return {
          snapshot,
          ownerToken,
          lists: snapshot.filter(([key]) => key[0] === "issues") as Array<
            [QueryKey, IssueListPage | undefined]
          >,
          inboxes: snapshot.filter(([key]) => key[0] === "inbox") as Array<
            [QueryKey, InboxPage | undefined]
          >,
        };
      } catch (error) {
        await settleRuntimeWrite(queryClient, ownerToken).catch(() => {});
        throw error;
      }
    },
    onError: (error, _vars, context) => {
      if (context) {
        for (const [key, data] of context.snapshot) {
          writeRuntimeData(queryClient, key, data, context.ownerToken);
        }
      }
      toast.error(`Could not mark as read: ${error.message}`);
    },
    onSettled: async (_data, _error, vars, context) => {
      if (context)
        await settleRuntimeWrite(queryClient, context.ownerToken).catch(
          () => {},
        );
      await invalidateReadQueries(
        queryClient,
        vars,
        context?.snapshot.map(([key]) => key),
      ).catch(() => {});
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
export function useMarkReadAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: ReadTarget) =>
      api.markIssueRead(vars.slug, vars.number, {}),
    onMutate: async (vars: ReadTarget) => {
      const filters = {
        queryKey: ["issues", vars.slug],
        predicate: (query: { queryKey: QueryKey; state: { data: unknown } }) =>
          readMutationAffects(query.queryKey, query.state.data, vars),
      };
      const ownerToken = beginRuntimeWrite(queryClient, filters);
      try {
        await queryClient.cancelQueries(filters);
        const snapshot = queryClient.getQueriesData<IssueListPage>(filters);
        for (const [key, data] of snapshot) {
          if (!data || !("items" in data)) continue;
          writeRuntimeData(
            queryClient,
            key,
            clearUnread(data, vars.number),
            ownerToken,
          );
        }
        return { snapshot, ownerToken };
      } catch (error) {
        await settleRuntimeWrite(queryClient, ownerToken).catch(() => {});
        throw error;
      }
    },
    onError: (error, _vars, context) => {
      if (context) {
        for (const [key, data] of context.snapshot) {
          writeRuntimeData(queryClient, key, data, context.ownerToken);
        }
      }
      toast.error(`Could not mark as read: ${error.message}`);
    },
    onSettled: async (_data, _error, vars, context) => {
      if (context)
        await settleRuntimeWrite(queryClient, context.ownerToken).catch(
          () => {},
        );
      await invalidateReadQueries(
        queryClient,
        vars,
        context?.snapshot.map(([key]) => key),
      ).catch(() => {});
    },
  });
}
