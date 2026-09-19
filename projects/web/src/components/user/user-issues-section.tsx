import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  UserIssueRole,
  UserIssueState,
  UserIssuesPage,
} from "@todou/shared";
import { useEffect, useMemo, useRef } from "react";
import { userIssuesPageQuery, userIssuesQuery } from "@/api/users.ts";
import { IssueRow, useIssueListGrid } from "@/components/issue/issue-row.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { LoadMoreFooter } from "@/components/shared/load-more.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import {
  useCancelReturnRestore,
  useRegisterReturnArea,
  useRegisterReturnLane,
} from "@/components/shared/return-context.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { WINDOW_REGION } from "@/lib/return-view.ts";
import { useHeaderHeight } from "@/lib/use-header-height.ts";
import { usePagedAppend } from "@/lib/use-paged-append.ts";
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
 * The rows a reading position is remembered against (T-407), read out of the
 * DOM: it is the laid-out element the sampler measures, not the item.
 * `data-return-id` carries an issue's database id, which survives the move
 * that rewrites its number.
 */
function returnRows(
  root: HTMLElement | null,
): { id: string; element: HTMLElement }[] {
  if (root === null) return [];
  const found = root.querySelectorAll<HTMLElement>("[data-return-id]");
  return [...found].flatMap((element) => {
    const id = element.dataset.returnId;
    return id === undefined || id === "" ? [] : [{ id, element }];
  });
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
  onReady,
}: {
  login: string;
  role: UserIssueRole;
  state: UserIssueState;
  onFilters: (next: { role?: UserIssueRole; state?: UserIssueState }) => void;
  /** Whether this list is past its skeleton; see `useReturnView`'s `ready`. */
  onReady?: (ready: boolean) => void;
}) {
  const filters = { ref: login, role, state };
  const query = userIssuesQuery(filters);
  const first = useQuery(query);
  const grid = useIssueListGrid();
  const queryClient = useQueryClient();
  const headerHeight = useHeaderHeight();
  const rootRef = useRef<HTMLElement>(null);
  const cancelRestore = useCancelReturnRestore();

  // Pages appended under another login or filter must never appear with the
  // current first page, even while the new query is still loading.
  const paginationKey = JSON.stringify(query.queryKey);
  const paged = usePagedAppend<UserIssuesPage>(paginationKey);
  const focusRequested = useRef(false);
  const hasContent = first.data !== undefined || paged.pages.length > 0;
  const { replace, notice } = useReadFailure(
    [first.isError ? first.error : null],
    hasContent,
    query.queryKey,
  );
  const items = useMemo(
    () => [
      ...(first.data?.items ?? []),
      ...paged.pages.flatMap((page) => page.items),
    ],
    [paged.pages, first.data?.items],
  );
  const projects = useMemo(() => items.map((item) => item.project), [items]);
  const refs = useProjectRefs(projects);
  // The newest loaded page decides. Falling back to page 1's cursor would
  // resurrect it at the end of the list and re-append that page forever.
  const lastPage = paged.pages.at(-1) ?? first.data;
  const lastCursor = lastPage?.has_more ? lastPage.next_cursor : null;

  /** One more page, with none of the meaning a reader's click carries. */
  function loadNextPage() {
    if (!lastCursor) return;
    paged.append(() =>
      queryClient.fetchQuery(userIssuesPageQuery(filters, lastCursor)),
    );
  }

  // The reader's own control, which the restore driver's call must not be
  // mistaken for: paging past what a snapshot remembered means they have
  // taken the view over. It also arms the focus hand-off a click owes — a
  // replayed page is not a click and may not move the focus (T-411).
  function loadMore() {
    // A Retry after a replayed page failed is the restore continuing, not the
    // reader taking over: cancelling there would stop the range at the page
    // that broke even though the retry succeeded (T-407).
    if (paged.error === null) cancelRestore();
    focusRequested.current = true;
    loadNextPage();
  }

  // One flat lane: this list has no groups to read to different depths.
  // `paged.error` closes the lane only for the moment: the restore stays owed
  // the page, and the reader's Retry is what completes it. `exhausted` is the
  // separate question — whether a further page exists at all (T-407).
  useRegisterReturnLane({
    lane: "flat",
    loaded: paged.pages.length,
    canLoadMore: lastCursor !== null && !paged.pending && paged.error === null,
    exhausted: lastCursor === null,
    loadMore: loadNextPage,
  });
  // The window scrolls this page, and nothing floats over it but the shell
  // header. The rows are read from this section alone, so the projects
  // section below it cannot contribute an anchor (T-407).
  useRegisterReturnArea({
    region: WINDOW_REGION,
    element: () => null,
    rows: () => returnRows(rootRef.current),
    inset: () => headerHeight,
    axis: "y",
  });

  // Not ready while an appended page is in flight: the list is then a page
  // short of what the reader left, and a position located against it would
  // land them above the rows they were reading. A failed read stays not ready
  // too — the restore keeps waiting, so Retry still lands them where they
  // were (T-407).
  const rowsReady = hasContent && !paged.pending;
  useEffect(() => {
    onReady?.(rowsReady);
  }, [onReady, rowsReady]);
  // A section that has gone back to its skeleton — the page's own read reset,
  // a logout — must not leave the page above it describing itself as
  // measurable. Its dep is stable, so this cleanup is the unmount and nothing
  // else.
  useEffect(() => () => onReady?.(false), [onReady]);

  return (
    <section ref={rootRef} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Their cards</h2>
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
          No cards you can see 🥔
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
            <LoadMoreFooter
              pending={paged.pending}
              error={paged.error}
              onLoadMore={loadMore}
              focusRequested={focusRequested}
            />
          )}
        </>
      )}
    </section>
  );
}
