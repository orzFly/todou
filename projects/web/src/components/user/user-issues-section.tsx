import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  UserIssueRole,
  UserIssueState,
  UserIssuesPage,
} from "@todou/shared";
import { useMemo, useState } from "react";
import { userIssuesPageQuery, userIssuesQuery } from "@/api/users.ts";
import { IssueRow, useIssueListGrid } from "@/components/issue/issue-row.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectRefs } from "@/lib/use-project-refs.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";
import { cn } from "@/lib/utils";

const ROLES: { key: UserIssueRole; label: string }[] = [
  { key: "any", label: "All" },
  { key: "author", label: "Created" },
  { key: "assignee", label: "Assigned" },
];

const STATES: { key: UserIssueState; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

/**
 * The inbox's segmented tabs rather than `FilterBar`, which is built around
 * one project's statuses, labels and members — none of which a list
 * spanning projects has.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={value === option.key}
          className={cn(
            "cursor-pointer rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground",
            value === option.key && "bg-accent font-medium text-foreground",
          )}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The cards someone is involved in, across every project the reader can see
 * (T-374). Rows are the shared `IssueRow` (T-118) carrying `slug` per row,
 * because this list mixes projects exactly as the inbox does.
 *
 * `role` and `state` come from the route's search params, so a filtered
 * view is a URL somebody can send.
 */
export function UserIssuesSection({
  login,
  role,
  state,
  onFilters,
}: {
  login: string;
  role: UserIssueRole;
  state: UserIssueState;
  onFilters: (next: { role?: UserIssueRole; state?: UserIssueState }) => void;
}) {
  const filters = { ref: login, role, state };
  const query = userIssuesQuery(filters);
  const first = useQuery(query);
  const grid = useIssueListGrid();
  const queryClient = useQueryClient();

  // Pages appended under another login or filter must never appear with the
  // current first page, even while the new query is still loading.
  const paginationKey = JSON.stringify(query.queryKey);
  const [pagination, setPagination] = useState<{
    key: string;
    pages: UserIssuesPage[];
  }>(() => ({ key: paginationKey, pages: [] }));
  if (pagination.key !== paginationKey) {
    setPagination({ key: paginationKey, pages: [] });
  }
  const extraPages = pagination.key === paginationKey ? pagination.pages : [];
  const hasContent = first.data !== undefined || extraPages.length > 0;
  const { replace, notice } = useReadFailure(
    [first.isError ? first.error : null],
    hasContent,
    query.queryKey,
  );
  const items = useMemo(
    () => [...(first.data?.items ?? []), ...extraPages.flatMap((p) => p.items)],
    [extraPages, first.data?.items],
  );
  const projects = useMemo(() => items.map((item) => item.project), [items]);
  const refs = useProjectRefs(projects);
  // The newest loaded page decides. Falling back to page 1's cursor would
  // resurrect it at the end of the list and re-append that page forever.
  const lastPage = extraPages.at(-1) ?? first.data;
  const lastCursor = lastPage?.has_more ? lastPage.next_cursor : null;

  async function loadMore() {
    if (!lastCursor) return;
    const next = await queryClient.fetchQuery(
      userIssuesPageQuery(filters, lastCursor),
    );
    setPagination((current) =>
      current.key === paginationKey
        ? { key: current.key, pages: [...current.pages, next] }
        : current,
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Ta 的卡</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            options={ROLES}
            value={role}
            onChange={(next) => onFilters({ role: next })}
            label="Involvement"
          />
          <Segmented
            options={STATES}
            value={state}
            onChange={(next) => onFilters({ state: next })}
            label="State"
          />
        </div>
      </div>

      {notice && (
        <RefreshFailure
          what="these cards"
          detail={notice}
          onRetry={() => first.refetch()}
          retrying={first.isFetching}
        />
      )}

      {replace ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <LoadFailure
            message={`Could not load these cards: ${replace}`}
            detail={replace}
            onRetry={() => first.refetch()}
            retrying={first.isFetching}
            className="justify-center"
          />
        </div>
      ) : !hasContent ? (
        <Skeleton className="h-32 w-full" />
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          没有你能看到的卡 🥔
        </div>
      ) : (
        <>
          <ul className={cn("rounded-lg border", grid)}>
            {items.map((item) => (
              <IssueRow
                key={`${item.project.id}/${item.id}`}
                slug={item.project.slug}
                issue={item}
                trailing={
                  <span className="ml-auto flex shrink-0 items-center gap-2 max-sm:hidden">
                    <StatusPill status={item.status} />
                    <ProjectIcon
                      project={{
                        name: item.project.name,
                        prefix: refs.get(item.project.slug)?.prefix ?? null,
                        icon_url: item.project.icon_url,
                      }}
                      className="size-5"
                      aria-hidden
                    />
                    <span className="text-xs text-muted-foreground">
                      {item.project.name}
                    </span>
                  </span>
                }
              />
            ))}
          </ul>
          {lastCursor && (
            <div className="text-center">
              <Button variant="outline" size="sm" onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
