import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
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
  Status,
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
import { FilterBar } from "@/components/issue/filter-bar.tsx";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
      <IssueTable
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
export function IssueTable({
  slug,
  page,
  statuses,
  allLabels,
  search,
}: {
  slug: string;
  page: IssueListPageData;
  statuses: Status[];
  allLabels: Array<{ id: number; name: string; color: string }>;
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
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-36">Status</TableHead>
              <TableHead className="w-44">Labels</TableHead>
              <TableHead className="w-40">Assignees</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
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
          </TableBody>
        </Table>
      </div>
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
  allLabels: Array<{ id: number; name: string; color: string }>;
  onStatus: (status: Status) => void;
  onToggleLabel: (labelId: number) => void;
}) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground">
        {/* Fixed-width slot (the CLI's ● column) so numbers never shift. */}
        <span className="mr-1.5 inline-block size-2 align-middle">
          {issue.unread && (
            <span
              className="block size-2 rounded-full bg-blue-500 dark:bg-blue-400"
              title="new activity since you last viewed"
            />
          )}
        </span>
        #{issue.number}
      </TableCell>
      <TableCell>
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issue.number) }}
          className="font-medium hover:underline"
        >
          {issue.title}
        </Link>
        {issue.open_questions > 0 && (
          <span
            className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 align-middle text-xs text-amber-700 dark:text-amber-400"
            title={`${issue.open_questions} unanswered question(s)`}
          >
            <MessageCircleQuestionIcon className="size-3.5" />
            {issue.open_questions}
          </span>
        )}
        {issue.spec_review_status === "unreviewed" && (
          <span
            className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 align-middle text-xs text-amber-700 dark:text-amber-400"
            title={`spec v${issue.spec_version} is awaiting review`}
          >
            <BookOpenTextIcon className="size-3.5" />
            spec
          </span>
        )}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger className="cursor-pointer">
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
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          {issue.labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger className="cursor-pointer text-muted-foreground hover:text-foreground">
              <TagIcon className="size-3.5" aria-label="edit labels" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {allLabels.length === 0 && (
                <DropdownMenuItem disabled>No labels defined</DropdownMenuItem>
              )}
              {allLabels.map((label) => (
                <DropdownMenuItem
                  key={label.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    onToggleLabel(label.id);
                  }}
                >
                  <span className="w-4">
                    {issue.labels.some((l) => l.id === label.id) && (
                      <CheckIcon className="size-4" />
                    )}
                  </span>
                  {label.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          {issue.assignees.map((user) => (
            <UserChip key={user.id} user={user} compact />
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}
