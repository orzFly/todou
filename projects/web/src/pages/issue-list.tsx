import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type {
  IssueCounts,
  IssueListItem,
  IssueListPage as IssueListPageData,
  Label,
  Status,
} from "@todou/shared";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  csvToIds,
  effectiveCategory,
  effectiveGroup,
  effectiveSort,
  type IssueSearch,
  issueCountsQuery,
  issueGroupQuery,
  issuesQuery,
  listParams,
  useIssueLabelsMutation,
  useIssueStatusMutation,
  useRestoreIssueMutation,
} from "@/api/issues.ts";
import {
  api,
  labelsQuery,
  membersQuery,
  statusesQuery,
  useIsProjectAdmin,
} from "@/api/queries.ts";
import { FilterBar } from "@/components/issue/filter-bar.tsx";
import {
  ISSUE_LIST_ROW,
  IssueRow,
  IssueRowMeta,
  useIssueListGrid,
} from "@/components/issue/issue-row.tsx";
import { useCreateLabel } from "@/components/issue/label-picker.tsx";
import { MarkAllReadButton } from "@/components/issue/mark-all-read-button.tsx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The list route serves two pages: the issue list and the trash (T-145).
 * They are separate components, not one with a branch, because they need
 * different hooks — a conditional inside one component would change the hook
 * count the moment `?deleted=1` is toggled.
 */
export function IssueListPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const search = useSearch({ from: "/authed/projects/$slug/" });
  return search.deleted ? (
    <TrashView slug={slug} search={search} />
  ) : (
    <ProjectIssueListPage slug={slug} search={search} />
  );
}

function ProjectIssueListPage({
  slug,
  search,
}: {
  slug: string;
  search: IssueSearch;
}) {
  const navigate = useNavigate();
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const labels = useSuspenseQuery(labelsQuery(slug));
  const members = useSuspenseQuery(membersQuery(slug));
  const counts = useSuspenseQuery(issueCountsQuery(slug, search));
  const isAdmin = useIsProjectAdmin(slug);
  const createLabel = useCreateLabel(slug);

  const setSearch = (next: IssueSearch) =>
    navigate({
      to: "/projects/$slug",
      params: { slug },
      search: next,
      replace: true,
    });

  // Group headers pin below whatever floats above them: the toolbar on desktop,
  // the (taller, two-row) app header alone on mobile. Neither height is knowable
  // in CSS across wrapping and breakpoints, so measure into a variable (same
  // approach as the board's fitCanvas). Take the toolbar's pinned bottom edge
  // rather than adding the two heights: the toolbar sticks at its own top and
  // tucks under the app header's 1px bottom border, so the sum overshoots by
  // that border and leaves a 1px strip of the list showing through (T-167).
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const toolbar = toolbarRef.current;
    if (!root || !toolbar) return;
    const appbar = document.querySelector("header");
    const measure = () => {
      const pinned = Number.parseFloat(getComputedStyle(toolbar).top);
      const floats = window.matchMedia("(min-width: 640px)").matches;
      const top =
        floats && Number.isFinite(pinned)
          ? pinned + toolbar.getBoundingClientRect().height
          : (appbar?.getBoundingClientRect().height ?? 0);
      root.style.setProperty("--group-sticky-top", `${top}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    if (appbar) observer.observe(appbar);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  const grouped =
    effectiveCategory(search) === "open" && effectiveGroup(search) === "status";

  return (
    <div ref={rootRef} className="space-y-4">
      {/* The toolbar floats over the list on desktop (T-88); -mx/px let its
          backdrop bleed into the shell's horizontal padding. */}
      <div
        ref={toolbarRef}
        className="-mx-4 flex flex-wrap items-center gap-2 px-4 py-1.5 sm:sticky sm:top-14 sm:z-30 sm:bg-background/95 sm:backdrop-blur"
      >
        <FilterBar
          search={search}
          counts={counts.data}
          statuses={statuses.data}
          labels={labels.data}
          members={members.data}
          onChange={setSearch}
        />
        {/* Its own line, right-aligned: the filters fill the bar at every
            container width, and squeezing this in as an unlabelled icon
            would hide a project-wide action inside a row of view controls
            (T-100). The group headers pin below it either way — the sticky
            offset is measured, not hard-coded. */}
        <MarkAllReadButton
          slug={slug}
          scopeName="this project"
          className="ml-auto"
        />
        {/* Admin-only, because only they see the whole project's trash. An
            author with deleted cards of their own reaches the same view by
            URL or through `todou issue list --deleted`. */}
        {isAdmin && (
          <Button variant="ghost" size="sm" asChild>
            <Link
              to="/projects/$slug"
              params={{ slug }}
              search={{ deleted: true }}
            >
              <Trash2Icon />
              Trash
            </Link>
          </Button>
        )}
      </div>
      {grouped ? (
        <GroupedIssueList
          slug={slug}
          statuses={statuses.data}
          counts={counts.data}
          allLabels={labels.data}
          search={search}
          onCreateLabel={isAdmin ? createLabel : undefined}
        />
      ) : (
        <FlatIssueList
          slug={slug}
          statuses={statuses.data}
          allLabels={labels.data}
          search={search}
          onCreateLabel={isAdmin ? createLabel : undefined}
        />
      )}
    </div>
  );
}

/**
 * The trash (T-145): one flat list of what the viewer may see in there, each
 * row offering the one action that applies. No filter bar and no grouping —
 * open/closed and status columns describe work in progress, and nothing in
 * here is in progress.
 *
 * Exported for tests.
 */
export function TrashView({
  slug,
  search,
}: {
  slug: string;
  search: IssueSearch;
}) {
  const issues = useSuspenseQuery(issuesQuery(slug, search));
  const restore = useRestoreIssueMutation(slug);
  const grid = useIssueListGrid();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-heading text-lg font-medium">
          <Trash2Icon className="size-4 text-muted-foreground" />
          Trash
        </h2>
        <p className="text-sm text-muted-foreground">
          Deleted issues, newest first. Restoring brings a card back with
          everything on it; numbers are never reused.
        </p>
        <Button variant="ghost" size="sm" asChild className="ml-auto">
          <Link to="/projects/$slug" params={{ slug }} search={{}}>
            <ArrowLeftIcon />
            Back to issues
          </Link>
        </Button>
      </div>
      {issues.data.items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          The trash is empty. 干干净净 🧺
        </div>
      ) : (
        <ul className={cn("rounded-lg border", grid)}>
          {issues.data.items.map((issue) => (
            <IssueRow
              key={issue.id}
              slug={slug}
              issue={issue}
              trailing={
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  {issue.deleted_at && (
                    <span
                      className="text-xs whitespace-nowrap text-muted-foreground"
                      title={issue.deleted_at}
                    >
                      deleted {new Date(issue.deleted_at).toLocaleDateString()}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(issue.number)}
                  >
                    Restore
                  </Button>
                </span>
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The flat page query lives below the grouped/flat fork so the grouped view
 * never pays for a list page it does not render.
 */
function FlatIssueList({
  slug,
  statuses,
  allLabels,
  search,
  onCreateLabel,
}: {
  slug: string;
  statuses: Status[];
  allLabels: Label[];
  search: IssueSearch;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  const issues = useSuspenseQuery(issuesQuery(slug, search));
  return (
    <IssueList
      slug={slug}
      page={issues.data}
      statuses={statuses}
      allLabels={allLabels}
      search={search}
      onCreateLabel={onCreateLabel}
    />
  );
}

/**
 * The grouped default of the open view (T-88): one section per non-empty
 * open status, later pipeline stages first. Exported for tests.
 */
export function GroupedIssueList({
  slug,
  statuses,
  counts,
  allLabels,
  search,
  onCreateLabel,
}: {
  slug: string;
  statuses: Status[];
  counts: IssueCounts;
  allLabels: Label[];
  search: IssueSearch;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  const selected = csvToIds(search.status);
  const groups = groupStatuses(statuses, counts, selected);

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
        No issues match. 地里很干净 🥔
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((status) => (
        <IssueGroup
          key={status.id}
          slug={slug}
          status={status}
          total={counts.by_status[String(status.id)] ?? 0}
          statuses={statuses}
          allLabels={allLabels}
          search={search}
          onCreateLabel={onCreateLabel}
        />
      ))}
    </div>
  );
}

/**
 * The groups worth rendering: open statuses with matches, later stages
 * first, narrowed by the URL's multi-status filter. Exported for tests.
 */
export function groupStatuses(
  statuses: Status[],
  counts: IssueCounts,
  selected: number[] | undefined,
): Status[] {
  return statuses
    .filter((s) => s.category === "open")
    .filter((s) => selected === undefined || selected.includes(s.id))
    .filter((s) => (counts.by_status[String(s.id)] ?? 0) > 0)
    .sort((a, b) => b.position - a.position);
}

function IssueGroup({
  slug,
  status,
  total,
  statuses,
  allLabels,
  search,
  onCreateLabel,
}: {
  slug: string;
  status: Status;
  total: number;
  statuses: Status[];
  allLabels: Label[];
  search: IssueSearch;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  const group = useQuery(issueGroupQuery(slug, status.id, search));
  const grid = useIssueListGrid();
  const [extraPages, setExtraPages] = useState<IssueListPageData[]>([]);
  const queryClient = useQueryClient();

  // Same guard as IssueList: pages loaded under a previous filter state
  // would mix stale rows into the group.
  const paginationKey = JSON.stringify([slug, search, status.id]);
  const [loadedFor, setLoadedFor] = useState(paginationKey);
  if (loadedFor !== paginationKey) {
    setLoadedFor(paginationKey);
    setExtraPages([]);
  }

  const items = [
    ...(group.data?.items ?? []),
    ...extraPages.flatMap((p) => p.items),
  ];
  const lastCursor =
    extraPages.length === 0
      ? (group.data?.next_cursor ?? null)
      : (extraPages.at(-1)?.next_cursor ?? null);
  // The optimistic move patches only the first page, so the loaded count
  // can drift by one from `total` until the server refetch settles; clamp
  // so the button never offers "Show 0 more".
  const remaining = Math.max(total - items.length, 0);

  async function loadMore() {
    if (!lastCursor) return;
    const base = issueGroupQuery(slug, status.id, search);
    const next = await queryClient.fetchQuery({
      queryKey: [...base.queryKey, lastCursor],
      queryFn: () =>
        api.listIssues(slug, {
          status: [status.id],
          q: search.q,
          label: csvToIds(search.label),
          assignee: search.assignee,
          ...effectiveSort(search),
          cursor: lastCursor,
        }),
    });
    setExtraPages((prev) => [...prev, next]);
  }

  return (
    <section aria-label={status.name}>
      {/* Outside the header's rounded top corners sit two transparent notches;
          rows passing behind a pinned header show their own border and
          background through them. The square-cornered shell carries the pin so
          those notches always fall back to the page colour, the same backdrop
          the gaps between groups have (T-167). */}
      <div
        className="sticky z-20 bg-background"
        style={{ top: "var(--group-sticky-top, 56px)" }}
      >
        <div className="flex items-center gap-2 rounded-t-lg border bg-muted px-3.5 py-2 text-sm">
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: status.color }}
            aria-hidden
          />
          <span className="font-medium">{status.name}</span>
          <span className="text-muted-foreground">{total}</span>
        </div>
      </div>
      <ul className={cn("rounded-b-lg border border-t-0", grid)}>
        {group.isPending && (
          <li className={cn(ISSUE_LIST_ROW, "p-3")}>
            <Skeleton className="h-12 w-full" />
          </li>
        )}
        {group.isError && (
          <li
            className={cn(
              ISSUE_LIST_ROW,
              "flex items-center justify-between gap-2 p-3 text-sm text-muted-foreground",
            )}
          >
            Could not load this group: {group.error.message}
            <Button variant="outline" size="sm" onClick={() => group.refetch()}>
              Retry
            </Button>
          </li>
        )}
        <ProjectIssueRows
          slug={slug}
          items={items}
          statuses={statuses}
          allLabels={allLabels}
          onCreateLabel={onCreateLabel}
        />
        {lastCursor && remaining > 0 && (
          <li className={ISSUE_LIST_ROW}>
            <button
              type="button"
              className="w-full cursor-pointer p-2 text-center text-sm text-muted-foreground hover:text-foreground"
              onClick={loadMore}
            >
              Show {remaining} more…
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

/** Exported for tests (pagination state, like IssueRow). */
export function IssueList({
  slug,
  page,
  statuses,
  allLabels,
  search,
  onCreateLabel,
}: {
  slug: string;
  page: IssueListPageData;
  statuses: Status[];
  allLabels: Label[];
  search: IssueSearch;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  const grid = useIssueListGrid();
  const [extraPages, setExtraPages] = useState<IssueListPageData[]>([]);
  const queryClient = useQueryClient();

  // Pages were appended under the previous filter state; keeping them would
  // mix e.g. closed rows into the open list after a category switch.
  const paginationKey = JSON.stringify([slug, search]);
  const [loadedFor, setLoadedFor] = useState(paginationKey);
  if (loadedFor !== paginationKey) {
    setLoadedFor(paginationKey);
    setExtraPages([]);
  }

  const items = [...page.items, ...extraPages.flatMap((p) => p.items)];
  // A null next_cursor on the newest loaded page means the end was reached;
  // `??` would resurrect page 1's cursor there and Load More would re-append
  // page 2 forever.
  const lastCursor =
    extraPages.length === 0
      ? page.next_cursor
      : (extraPages.at(-1)?.next_cursor ?? null);

  async function loadMore() {
    if (!lastCursor) return;
    const next = await queryClient.fetchQuery({
      queryKey: ["issues", slug, search, lastCursor],
      queryFn: () =>
        api.listIssues(slug, { ...listParams(search), cursor: lastCursor }),
    });
    setExtraPages((prev) => [...prev, next]);
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
        No issues match. 地里很干净 🥔
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className={cn("rounded-lg border", grid)}>
        <ProjectIssueRows
          slug={slug}
          items={items}
          statuses={statuses}
          allLabels={allLabels}
          onCreateLabel={onCreateLabel}
        />
      </ul>
      {lastCursor && (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={loadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The rows of a project list: the shared row (T-118) plus the editable meta
 * line, which is what this page adds over the inbox's read-only one. Both
 * the grouped and the flat list render through here, so the mutation wiring
 * is written once; it returns bare `<li>`s because the callers own the `<ul>`
 * (the grouped one seats skeleton and error rows in the same list).
 *
 * Exported for tests.
 */
export function ProjectIssueRows({
  slug,
  items,
  statuses,
  allLabels,
  onCreateLabel,
}: {
  slug: string;
  items: IssueListItem[];
  statuses: Status[];
  allLabels: Label[];
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  const statusMutation = useIssueStatusMutation(slug);
  const labelsMutation = useIssueLabelsMutation(slug);
  return items.map((issue) => (
    <IssueRow
      key={issue.id}
      slug={slug}
      issue={issue}
      meta={
        <IssueRowMeta
          issue={issue}
          statuses={statuses}
          allLabels={allLabels}
          onStatus={(status) =>
            statusMutation.mutate({ issueNumber: issue.number, status })
          }
          onToggleLabel={(label) => {
            const current = issue.labels.map((l) => l.id);
            labelsMutation.mutate({
              issueNumber: issue.number,
              labelIds: current.includes(label.id)
                ? current.filter((id) => id !== label.id)
                : [...current, label.id],
            });
          }}
          onCreateLabel={onCreateLabel}
        />
      }
    />
  ));
}
