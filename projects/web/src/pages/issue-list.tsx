import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type {
  IssueListItem,
  IssueListPage as IssueListPageData,
  Status,
} from "@todou/shared";
import { CheckIcon, TagIcon } from "lucide-react";
import { useState } from "react";
import {
  type IssueSearch,
  issuesQuery,
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
import { NewIssueDialog } from "@/components/issue/new-issue-dialog.tsx";
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

  const setSearch = (next: IssueSearch) =>
    navigate({
      to: "/projects/$slug",
      params: { slug },
      search: next,
      replace: true,
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterBar
          search={search}
          statuses={statuses.data}
          labels={labels.data}
          members={members.data}
          onChange={setSearch}
        />
        <NewIssueDialog slug={slug} statuses={statuses.data} />
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

function IssueTable({
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

  const items = [...page.items, ...extraPages.flatMap((p) => p.items)];
  const lastCursor = extraPages.at(-1)?.next_cursor ?? page.next_cursor ?? null;

  async function loadMore() {
    if (!lastCursor) return;
    const next = await queryClient.fetchQuery({
      queryKey: ["issues", slug, search, lastCursor],
      queryFn: () =>
        api.listIssues(slug, {
          q: search.q,
          category: search.category,
          status: search.status,
          label: search.label,
          assignee: search.assignee,
          sort: search.sort,
          order: search.order,
          cursor: lastCursor,
        }),
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

function IssueRow({
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
      <TableCell className="text-muted-foreground">#{issue.number}</TableCell>
      <TableCell>
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issue.number) }}
          className="font-medium hover:underline"
        >
          {issue.title}
        </Link>
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
