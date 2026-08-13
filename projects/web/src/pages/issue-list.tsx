import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  formatRef,
  type IssueCounts,
  type IssueListItem,
  type IssueListPage as IssueListPageData,
  type Label,
  type Status,
} from "@todou/shared";
import {
  BookOpenTextIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDotIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  TagIcon,
} from "lucide-react";
import { useState } from "react";
import {
  effectiveCategory,
  type IssueSearch,
  issueCountsQuery,
  issuesQuery,
  listParams,
  useIssueLabelsMutation,
  useIssueStatusMutation,
} from "@/api/issues.ts";
import {
  api,
  labelsQuery,
  membersQuery,
  statusesQuery,
} from "@/api/queries.ts";
import { useRefPrefix } from "@/api/references.ts";
import { FilterBar } from "@/components/issue/filter-bar.tsx";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { MarkReadButton } from "@/components/issue/mark-read-button.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function IssueListPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const search = useSearch({ from: "/authed/projects/$slug/" });
  const navigate = useNavigate();

  const statuses = useSuspenseQuery(statusesQuery(slug));
  const labels = useSuspenseQuery(labelsQuery(slug));
  const members = useSuspenseQuery(membersQuery(slug));
  const issues = useSuspenseQuery(issuesQuery(slug, search));
  const counts = useSuspenseQuery(issueCountsQuery(slug, search));

  const setSearch = (next: IssueSearch) =>
    navigate({
      to: "/projects/$slug",
      params: { slug },
      search: next,
      replace: true,
    });

  return (
    <div className="space-y-4">
      <CategoryTabs
        counts={counts.data}
        active={effectiveCategory(search)}
        onSelect={(category) =>
          setSearch({
            ...search,
            category: category === "open" ? undefined : category,
          })
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterBar
          search={search}
          statuses={statuses.data}
          labels={labels.data}
          members={members.data}
          onChange={setSearch}
        />
        <Button size="sm" asChild>
          <Link to="/projects/$slug/issues/new" params={{ slug }}>
            <PlusIcon /> New issue
          </Link>
        </Button>
      </div>
      <IssueList
        slug={slug}
        page={issues.data}
        statuses={statuses.data}
        allLabels={labels.data}
        search={search}
      />
    </div>
  );
}

function CategoryTabs({
  counts,
  active,
  onSelect,
}: {
  counts: IssueCounts;
  active: "open" | "closed" | "all";
  onSelect: (category: "open" | "closed") => void;
}) {
  const tab = (selected: boolean) =>
    selected
      ? "flex cursor-pointer items-center gap-1.5 font-semibold text-foreground"
      : "flex cursor-pointer items-center gap-1.5 text-muted-foreground hover:text-foreground";
  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        type="button"
        className={tab(active === "open")}
        onClick={() => onSelect("open")}
      >
        <CircleDotIcon className="size-4" />
        Open {counts.open}
      </button>
      <span className="text-muted-foreground">·</span>
      <button
        type="button"
        className={tab(active === "closed")}
        onClick={() => onSelect("closed")}
      >
        <CheckCircle2Icon className="size-4" />
        Closed {counts.closed}
      </button>
    </div>
  );
}

/** Exported for tests (pagination state, like IssueRow). */
export function IssueList({
  slug,
  page,
  statuses,
  allLabels,
  search,
}: {
  slug: string;
  page: IssueListPageData;
  statuses: Status[];
  allLabels: Label[];
  search: IssueSearch;
}) {
  const [extraPages, setExtraPages] = useState<IssueListPageData[]>([]);
  const queryClient = useQueryClient();
  const statusMutation = useIssueStatusMutation(slug);
  const labelsMutation = useIssueLabelsMutation(slug);

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
      <ul className="rounded-lg border">
        {items.map((issue) => (
          <IssueRow
            key={issue.id}
            slug={slug}
            issue={issue}
            statuses={statuses}
            allLabels={allLabels}
            onStatus={(status) =>
              statusMutation.mutate({ issueNumber: issue.number, status })
            }
            onToggleLabel={(labelId) => {
              const current = issue.labels.map((l) => l.id);
              labelsMutation.mutate({
                issueNumber: issue.number,
                labelIds: current.includes(labelId)
                  ? current.filter((id) => id !== labelId)
                  : [...current, labelId],
              });
            }}
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
    </div>
  );
}

/** Exported for tests (like BoardCardContent). */
export function IssueRow({
  slug,
  issue,
  statuses,
  allLabels,
  onStatus,
  onToggleLabel,
}: {
  slug: string;
  issue: IssueListItem;
  statuses: Status[];
  allLabels: Label[];
  onStatus: (status: Status) => void;
  onToggleLabel: (labelId: number) => void;
}) {
  const refPrefix = useRefPrefix(slug);
  return (
    <li className="border-b px-3.5 py-2.5 transition-colors last:border-0 hover:bg-muted/50">
      <div className="flex items-center gap-2">
        {/* Fixed-width slot (the CLI's ● column, sized for the 99+ badge)
            keeps numbers from shifting; centering keeps the ring and the
            badge on one axis. */}
        <span className="inline-flex w-[27px] shrink-0 justify-center">
          <MarkReadButton
            slug={slug}
            number={issue.number}
            unread={issue.unread}
            unreadComments={issue.unread_comments}
          />
        </span>
        <span className="w-11 shrink-0 text-[13px] text-muted-foreground tabular-nums max-sm:w-auto">
          {formatRef(refPrefix, issue.number)}
        </span>
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issue.number) }}
          className="min-w-0 truncate font-medium hover:underline"
        >
          {issue.title}
        </Link>
        {issue.open_questions > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
            title={`${issue.open_questions} unanswered question(s)`}
          >
            <MessageCircleQuestionIcon className="size-3.5" />
            {issue.open_questions}
          </span>
        )}
        {issue.spec_review_status === "unreviewed" && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
            title={`spec v${issue.spec_version} is awaiting review`}
          >
            <BookOpenTextIcon className="size-3.5" />
            spec
          </span>
        )}
      </div>
      {/* pl mirrors line 1: unread slot 27 + gap 8 (+ ref 44 when it is
          fixed-width, ≥sm only) so the meta line starts under the title. */}
      <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[79px] max-sm:pl-[35px]">
        <DropdownMenu>
          {/* flex collapses the button's line box to the pill; the default
              block box is 24px tall and seats the pill on its text baseline,
              ~1.6px below the neighbouring label chips (T-98). */}
          <DropdownMenuTrigger className="flex cursor-pointer">
            <StatusPill status={issue.status} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {statuses.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => onStatus(s)}>
                <span className="w-4">
                  {s.id === issue.status.id && <CheckIcon className="size-4" />}
                </span>
                <StatusPill status={s} className="border-0 px-0" />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {issue.labels.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex cursor-pointer text-muted-foreground hover:text-foreground">
            <TagIcon className="size-3.5" aria-label="edit labels" />
          </DropdownMenuTrigger>
          <LabelEditMenu
            allLabels={allLabels}
            issueLabels={issue.labels}
            onToggle={onToggleLabel}
          />
        </DropdownMenu>
        <span className="flex-1" />
        <span className="flex gap-1">
          {issue.assignees.map((user) => (
            <UserChip key={user.id} user={user} compact />
          ))}
        </span>
      </div>
    </li>
  );
}

function LabelEditMenu({
  allLabels,
  issueLabels,
  onToggle,
}: {
  allLabels: Label[];
  issueLabels: Label[];
  onToggle: (labelId: number) => void;
}) {
  return (
    <DropdownMenuContent>
      {allLabels.length === 0 && (
        <DropdownMenuItem disabled>No labels defined</DropdownMenuItem>
      )}
      {allLabels.map((label) => (
        <DropdownMenuItem
          key={label.id}
          onSelect={(e) => {
            e.preventDefault();
            onToggle(label.id);
          }}
        >
          <span className="w-4">
            {issueLabels.some((l) => l.id === label.id) && (
              <CheckIcon className="size-4" />
            )}
          </span>
          {label.name}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  );
}
