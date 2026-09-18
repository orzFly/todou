import {
  keepPreviousData,
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
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  csvToIds,
  effectiveCategory,
  effectiveGroup,
  effectiveSort,
  groupFilter,
  type IssueSearch,
  issueCountsQuery,
  issueGroupQuery,
  issuesQuery,
  listFilter,
  listParams,
  useIssueLabelsMutation,
  useIssueStatusMutation,
  useRestoreIssueMutation,
} from "@/api/issues.ts";
import { issuesEntry } from "@/api/issues-cache.ts";
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
import {
  useCanCreateLabels,
  useCreateLabel,
} from "@/components/issue/label-picker.tsx";
import { MarkAllReadButton } from "@/components/issue/mark-all-read-button.tsx";
import {
  IssueListBodySkeleton,
  PageSkeleton,
} from "@/components/page-skeleton.tsx";
import { ProjectMuteButton } from "@/components/project-mute-button.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import {
  LoadMoreFailure,
  LoadMoreFooter,
} from "@/components/shared/load-more.tsx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHeaderHeight } from "@/lib/use-header-height.ts";
import { usePagedAppend } from "@/lib/use-paged-append.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";
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

/** Exported for tests. */
export function ProjectIssueListPage({
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
  // Not a suspending read, and `placeholderData` is declared here rather than
  // in `issueCountsQuery`: `q` is part of this key, so under
  // `useSuspenseQuery` every keystroke suspended a component sitting above
  // this page's own boundary, the shell's boundary caught it, and the whole
  // page — search box included — was painted out for a skeleton (T-381).
  // `useSuspenseQuery` also forces `placeholderData` to undefined, so the
  // declaration would be dropped in silence if it lived in the queryOptions.
  const counts = useQuery({
    ...issueCountsQuery(slug, search),
    placeholderData: keepPreviousData,
  });
  const isAdmin = useIsProjectAdmin(slug);
  const canCreateLabels = useCanCreateLabels(slug);
  const createLabel = useCreateLabel(slug);

  const setSearch = (next: IssueSearch) =>
    navigate({
      to: "/projects/$slug",
      params: { slug },
      search: next,
      replace: true,
    });

  // What the search box holds right now. It lives here rather than inside
  // FilterBar because the rows have to narrow themselves by it while the
  // server's answer is still out (T-381).
  const [typed, setTyped] = useState(search.q ?? "");
  // The last value this page wrote into the URL, for telling our own write
  // apart from somebody else's down in the render-time sync.
  const written = useRef(search.q);
  const latest = useRef({ search, setSearch });
  useEffect(() => {
    latest.current = { search, setSearch };
  });
  // Only `typed` may restart the timer, which is why the current search and
  // the writer are read through a ref. With them in the dependency array —
  // the writer being a fresh arrow every render — a settling mutation, an SSE
  // invalidation or an arriving query pushed the write out by another 300ms,
  // and under a busy feed it never landed at all.
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = typed.trim() === "" ? undefined : typed.trim();
      const { search: current, setSearch: write } = latest.current;
      if (next === current.q) return;
      written.current = next;
      write({ ...current, q: next });
    }, 300);
    return () => clearTimeout(handle);
  }, [typed]);

  // A `?q=` link or a history step has to reach the box; the debounce landing
  // must not, or a write that fires mid-word resets the box to the word as it
  // stood 300ms ago and eats whatever was typed since.
  const [lastUrlQ, setLastUrlQ] = useState(search.q);
  if (lastUrlQ !== search.q) {
    setLastUrlQ(search.q);
    if (search.q !== written.current) setTyped(search.q ?? "");
  }

  // Neither sticky offset on this page can be a constant, so the toolbar takes
  // the measured header height and the group headers take the sum. Summing is
  // exact because the toolbar now pins at the header's own bottom edge; T-167's
  // 1px strip of list came from pinning it at 56 while the header ended at 57.
  const headerHeight = useHeaderHeight();
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const toolbar = toolbarRef.current;
    if (!root || !toolbar) return;
    const measure = () => {
      const floats = window.matchMedia("(min-width: 640px)").matches;
      const top = groupStickyTop(
        headerHeight,
        toolbar.getBoundingClientRect().height,
        floats,
      );
      root.style.setProperty("--group-sticky-top", `${top}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [headerHeight]);

  const grouped =
    effectiveCategory(search) === "open" && effectiveGroup(search) === "status";

  // Nothing upstream catches a failed counts read any more, so it is handled
  // where a failed group already is: inside the list area, with the header
  // and the toolbar left standing.
  const countsFailure = counts.isError ? (
    <LoadFailure
      message={`Could not load the counts: ${counts.error.message}`}
      detail={counts.error.message}
      onRetry={() => counts.refetch()}
      retrying={counts.isFetching}
    />
  ) : null;

  // Below every hook, so the branch cannot move the hook count. Reached on
  // the route's first paint and never again — `keepPreviousData` is what
  // keeps `data` from falling back to undefined once an answer has landed.
  if (counts.data === undefined) {
    return countsFailure ?? <PageSkeleton kind="list" />;
  }

  return (
    <div ref={rootRef} className="space-y-4">
      {/* The toolbar floats over the list on desktop (T-88); -mx/px let its
          backdrop bleed into the shell's horizontal padding. */}
      <div
        ref={toolbarRef}
        style={{ top: headerHeight }}
        className="-mx-4 flex flex-wrap items-center gap-2 px-4 py-1.5 sm:sticky sm:z-30 sm:bg-background/95 sm:backdrop-blur"
      >
        <FilterBar
          search={search}
          counts={counts.data}
          statuses={statuses.data}
          labels={labels.data}
          members={members.data}
          typed={typed}
          onTyped={setTyped}
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
        <ProjectMuteButton slug={slug} />
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
      {countsFailure}
      {/* Nothing underneath suspends any more, and this boundary stays as the
          guard rail: delete it and the next suspending read somebody adds to
          the list body escapes to the shell's boundary, which is exactly the
          failure T-381 was — the whole page painted out, the focus in the
          search box going with it. */}
      <Suspense fallback={<IssueListBodySkeleton />}>
        {grouped ? (
          <GroupedIssueList
            slug={slug}
            statuses={statuses.data}
            counts={counts.data}
            allLabels={labels.data}
            search={search}
            typed={typed}
            onCreateLabel={canCreateLabels ? createLabel : undefined}
          />
        ) : (
          <FlatIssueList
            slug={slug}
            statuses={statuses.data}
            allLabels={labels.data}
            search={search}
            typed={typed}
            onCreateLabel={canCreateLabels ? createLabel : undefined}
          />
        )}
      </Suspense>
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
  const restore = useRestoreIssueMutation();
  const grid = useIssueListGrid();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-heading text-lg font-medium">
          <Trash2Icon className="size-4 text-muted-foreground" />
          Trash
        </h2>
        <p className="text-sm text-muted-foreground">
          Restoring brings a card back with everything on it; numbers are never
          reused.
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
                    onClick={() =>
                      restore.mutate({ slug, issueNumber: issue.number })
                    }
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
 * never pays for a list page it does not render. Exported for tests, matching
 * GroupedIssueList.
 */
export function FlatIssueList({
  slug,
  statuses,
  allLabels,
  search,
  typed,
  onCreateLabel,
}: {
  slug: string;
  statuses: Status[];
  allLabels: Label[];
  search: IssueSearch;
  typed: string;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  const query = issuesQuery(slug, search);
  const issues = useQuery({
    ...query,
    placeholderData: keepPreviousData,
  });
  const data = issues.data;
  const hasContent = data !== undefined;
  const { replace, notice } = useReadFailure(
    [issues.isError ? issues.error : null],
    hasContent,
    query.queryKey,
  );

  if (replace) {
    return (
      <LoadFailure
        message={`Could not load the issues: ${replace}`}
        detail={replace}
        onRetry={() => issues.refetch()}
        retrying={issues.isFetching}
      />
    );
  }
  // On a key change, `keepPreviousData` is valid only while the new filter is
  // in flight. Query core drops that placeholder if the new request fails:
  // rows answered for the old filter are not content for the failed key and
  // must not survive underneath a refresh notice.
  if (!hasContent) return <IssueListBodySkeleton />;
  return (
    <div className="space-y-3">
      {notice && (
        <RefreshFailure
          what="the issues"
          detail={notice}
          onRetry={() => issues.refetch()}
          retrying={issues.isFetching}
        />
      )}
      <IssueList
        slug={slug}
        page={data}
        statuses={statuses}
        allLabels={allLabels}
        search={search}
        typed={typed}
        narrowing={isNarrowing(typed, search, issues.isPlaceholderData)}
        onCreateLabel={onCreateLabel}
      />
    </div>
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
  typed = "",
  onCreateLabel,
}: {
  slug: string;
  statuses: Status[];
  counts: IssueCounts;
  allLabels: Label[];
  search: IssueSearch;
  /** What the search box holds; see `narrowByTitle`. */
  typed?: string;
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
          typed={typed}
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

/**
 * Where the group headers pin: under the app header, plus the toolbar once it
 * floats. Both inputs are measured rather than named in CSS — the header gains
 * a row on narrow viewports, and the filters wrap at widths no breakpoint
 * knows. Exported for tests.
 */
export function groupStickyTop(
  headerHeight: number,
  toolbarHeight: number,
  toolbarFloats: boolean,
): number {
  return headerHeight + (toolbarFloats ? toolbarHeight : 0);
}

/**
 * The first stage of the search (T-381): the loaded rows whose title carries
 * what has been typed, computed without a request so the screen answers
 * within the frame.
 *
 * It only ever removes rows, and every row it keeps is one the server would
 * keep too — a title match satisfies the server's title-or-body match — which
 * is what lets it stand in as a preview of an answer that has not arrived.
 * The trimmed value is the one the URL gets, so a trailing space cannot empty
 * the list. Case folding is `toLowerCase` against Postgres's `ILIKE`, two
 * implementations that can disagree on some Unicode; the second stage
 * corrects the row either way, one round trip later.
 *
 * Exported for tests.
 */
export function narrowByTitle(
  items: IssueListItem[],
  typed: string,
): IssueListItem[] {
  const needle = typed.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}

/**
 * Whether the rows on screen are still the first stage's answer: either the
 * debounce has not written the URL yet, or it has and this list's own query
 * is still showing the previous search's rows. Past both windows the server's
 * answer is authoritative and the title filter has to stop — it would delete
 * every card the server matched on its body alone.
 */
function isNarrowing(
  typed: string,
  search: IssueSearch,
  showingPrevious: boolean,
): boolean {
  const typedQ = typed.trim() === "" ? undefined : typed.trim();
  return typedQ !== search.q || showingPrevious;
}

/**
 * The row that stands in for an empty first stage. Not "No issues match":
 * a typical search word is in 0–43% of the titles it matches cards through,
 * so an empty title filter says nothing about the answer, and claiming there
 * are none is contradicted a round trip later.
 */
const SEARCHING_ROW = "Searching…";

function IssueGroup({
  slug,
  status,
  total,
  statuses,
  allLabels,
  search,
  typed,
  onCreateLabel,
}: {
  slug: string;
  status: Status;
  total: number;
  statuses: Status[];
  allLabels: Label[];
  search: IssueSearch;
  typed: string;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  const group = useQuery({
    ...issueGroupQuery(slug, status.id, search),
    placeholderData: keepPreviousData,
  });
  const grid = useIssueListGrid();
  const queryClient = useQueryClient();

  // Same guard as IssueList: pages loaded under a previous filter state
  // would mix stale rows into the group.
  const paginationKey = JSON.stringify([slug, search, status.id]);
  const paged = usePagedAppend<IssueListPageData>(paginationKey);

  const items = useMemo(
    () => [
      ...(group.data?.items ?? []),
      ...paged.pages.flatMap((page) => page.items),
    ],
    [group.data, paged.pages],
  );
  const narrowing = isNarrowing(typed, search, group.isPlaceholderData);
  const shown = useMemo(
    () => (narrowing ? narrowByTitle(items, typed) : items),
    [narrowing, items, typed],
  );
  const lastCursor =
    paged.pages.length === 0
      ? (group.data?.next_cursor ?? null)
      : (paged.pages.at(-1)?.next_cursor ?? null);
  // The optimistic move patches only the first page, so the loaded count
  // can drift by one from `total` until the server refetch settles; clamp
  // so the button never offers "Show 0 more".
  const remaining = Math.max(total - items.length, 0);

  function loadMore() {
    if (!lastCursor) return;
    const base = issueGroupQuery(slug, status.id, search);
    paged.append(() =>
      queryClient.fetchQuery({
        ...issuesEntry([...base.queryKey, lastCursor], {
          kind: "page",
          filter: groupFilter(search, status.id, lastCursor),
        }),
        queryFn: () =>
          api.listIssues(slug, {
            status: [status.id],
            q: search.q,
            label: csvToIds(search.label),
            assignee: search.assignee,
            ...effectiveSort(search),
            cursor: lastCursor,
          }),
      }),
    );
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
          <li className={cn(ISSUE_LIST_ROW, "p-3 text-sm")}>
            <LoadFailure
              message={`Could not load this group: ${group.error.message}`}
              detail={group.error.message}
              onRetry={() => group.refetch()}
              retrying={group.isFetching}
            />
          </li>
        )}
        {narrowing && shown.length === 0 && (
          <li
            className={cn(ISSUE_LIST_ROW, "p-3 text-sm text-muted-foreground")}
          >
            {SEARCHING_ROW}
          </li>
        )}
        <ProjectIssueRows
          slug={slug}
          items={shown}
          statuses={statuses}
          allLabels={allLabels}
          onCreateLabel={onCreateLabel}
        />
        {/* Hidden while the first stage holds the screen: this button pages
            the query for the previous search word, and the count beside it is
            counting that word's matches. Both come back with the answer. */}
        {!narrowing && lastCursor && remaining > 0 && (
          <li
            className={
              paged.error ? cn(ISSUE_LIST_ROW, "p-3 text-sm") : ISSUE_LIST_ROW
            }
          >
            {paged.error ? (
              <LoadMoreFailure
                error={paged.error}
                onRetry={loadMore}
                retrying={paged.pending}
              />
            ) : (
              <button
                type="button"
                className="w-full cursor-pointer p-2 text-center text-sm text-muted-foreground hover:text-foreground"
                onClick={loadMore}
              >
                {paged.pending ? "Loading…" : `Show ${remaining} more…`}
              </button>
            )}
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
  typed = "",
  narrowing = false,
  onCreateLabel,
}: {
  slug: string;
  page: IssueListPageData;
  statuses: Status[];
  allLabels: Label[];
  search: IssueSearch;
  /** What the search box holds; see `narrowByTitle`. */
  typed?: string;
  /** Whether `page` is still the previous search word's answer. */
  narrowing?: boolean;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  const grid = useIssueListGrid();
  const queryClient = useQueryClient();

  // Pages were appended under the previous filter state; keeping them would
  // mix e.g. closed rows into the open list after a category switch.
  const paginationKey = JSON.stringify([slug, search]);
  const paged = usePagedAppend<IssueListPageData>(paginationKey);

  const items = useMemo(
    () => [...page.items, ...paged.pages.flatMap((next) => next.items)],
    [page.items, paged.pages],
  );
  const shown = useMemo(
    () => (narrowing ? narrowByTitle(items, typed) : items),
    [narrowing, items, typed],
  );
  // A null next_cursor on the newest loaded page means the end was reached;
  // `??` would resurrect page 1's cursor there and Load More would re-append
  // page 2 forever.
  const lastCursor =
    paged.pages.length === 0
      ? page.next_cursor
      : (paged.pages.at(-1)?.next_cursor ?? null);

  function loadMore() {
    if (!lastCursor) return;
    paged.append(() =>
      queryClient.fetchQuery({
        ...issuesEntry(["issues", slug, search, lastCursor], {
          kind: "page",
          filter: listFilter(search, lastCursor),
        }),
        queryFn: () =>
          api.listIssues(slug, { ...listParams(search), cursor: lastCursor }),
      }),
    );
  }

  // Only once the server has answered may the screen say there is nothing:
  // while the first stage holds it, an empty list is a missing answer.
  if (shown.length === 0 && !narrowing) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
        No issues match. 地里很干净 🥔
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className={cn("rounded-lg border", grid)}>
        {narrowing && shown.length === 0 && (
          <li
            className={cn(ISSUE_LIST_ROW, "p-3 text-sm text-muted-foreground")}
          >
            {SEARCHING_ROW}
          </li>
        )}
        <ProjectIssueRows
          slug={slug}
          items={shown}
          statuses={statuses}
          allLabels={allLabels}
          onCreateLabel={onCreateLabel}
        />
      </ul>
      {!narrowing && lastCursor && (
        <LoadMoreFooter
          pending={paged.pending}
          error={paged.error}
          onLoadMore={loadMore}
        />
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
  const statusMutation = useIssueStatusMutation();
  const labelsMutation = useIssueLabelsMutation();
  const statusMutate = statusMutation.mutate;
  const labelsMutate = labelsMutation.mutate;

  // Every prop below has to keep its identity across a render, or the memo on
  // the row is inert. Typing in the search box re-renders this list on every
  // keystroke now (T-381), and with 210 rows loaded in one group an unmemoed
  // row cost about 4ms each — a second of blocked main thread per character.
  const onStatus = useCallback(
    (issue: IssueListItem, status: Status) =>
      statusMutate({ slug, issueNumber: issue.number, status }),
    [statusMutate, slug],
  );
  const onToggleLabel = useCallback(
    (issue: IssueListItem, label: Label) => {
      const current = issue.labels.map((l) => l.id);
      labelsMutate({
        slug,
        issueNumber: issue.number,
        labelIds: current.includes(label.id)
          ? current.filter((id) => id !== label.id)
          : [...current, label.id],
      });
    },
    [labelsMutate, slug],
  );
  // `useCreateLabel` builds a fresh closure every render, so it travels
  // through a ref. Whether it exists at all is the viewer's permission and
  // stays a prop, because that does change what the row renders.
  const createLabel = useRef(onCreateLabel);
  useEffect(() => {
    createLabel.current = onCreateLabel;
  });
  const create = useCallback(
    (name: string) =>
      (createLabel.current as NonNullable<typeof onCreateLabel>)(name),
    [],
  );

  return items.map((issue) => (
    <ProjectIssueRow
      key={issue.id}
      slug={slug}
      issue={issue}
      statuses={statuses}
      allLabels={allLabels}
      onStatus={onStatus}
      onToggleLabel={onToggleLabel}
      onCreateLabel={onCreateLabel === undefined ? undefined : create}
    />
  ));
}

/**
 * One row, skipped entirely when nothing about it changed. The meta line is
 * built in here rather than handed down as an element, because an element
 * prop is a new object on every render and would make the memo a no-op.
 */
const ProjectIssueRow = memo(function ProjectIssueRow({
  slug,
  issue,
  statuses,
  allLabels,
  onStatus,
  onToggleLabel,
  onCreateLabel,
}: {
  slug: string;
  issue: IssueListItem;
  statuses: Status[];
  allLabels: Label[];
  onStatus: (issue: IssueListItem, status: Status) => void;
  onToggleLabel: (issue: IssueListItem, label: Label) => void;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
  return (
    <IssueRow
      slug={slug}
      issue={issue}
      meta={
        <IssueRowMeta
          issue={issue}
          statuses={statuses}
          allLabels={allLabels}
          onStatus={(status) => onStatus(issue, status)}
          onToggleLabel={(label) => onToggleLabel(issue, label)}
          onCreateLabel={onCreateLabel}
        />
      }
    />
  );
});
