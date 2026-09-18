import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { InboxItem } from "@todou/shared";
import { useMemo, useState } from "react";
import { groupInboxItems, type InboxGroup, inboxQuery } from "@/api/inbox.ts";
import { IssueRow, useIssueListGrid } from "@/components/issue/issue-row.tsx";
import { MarkAllReadButton } from "@/components/issue/mark-all-read-button.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectRefOption } from "@/lib/project-spellings.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "all", label: "All" },
  { key: "comments", label: "Comments" },
  { key: "specs", label: "Specs" },
  { key: "questions", label: "Questions" },
] as const;
export type InboxTab = (typeof TABS)[number]["key"];

/** Tab → reason predicate; exported pure for tests. */
export function matchesTab(item: InboxItem, tab: InboxTab): boolean {
  switch (tab) {
    case "all":
      return true;
    case "comments":
      return item.unread_comments > 0;
    case "specs":
      return item.pending_spec_review;
    case "questions":
      return item.open_questions > 0;
  }
}

/**
 * The cross-project inbox (T-97): everything that needs my attention,
 * grouped by project (design decision on the card), newest group first.
 */
export function InboxPage() {
  const inbox = useQuery(inboxQuery);
  const items = inbox.data?.items;
  const projects = useMemo(() => items?.map((item) => item.project), [items]);
  const refs = useProjectRefs(projects);
  const [tab, setTab] = useState<InboxTab>("all");
  const data = inbox.data;
  const hasContent = data !== undefined;
  const { replace, notice } = useReadFailure(
    [inbox.isError ? inbox.error : null],
    hasContent,
    inboxQuery.queryKey,
  );

  if (replace) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <LoadFailure
          message={`Could not load the inbox: ${replace}`}
          detail={replace}
          onRetry={() => inbox.refetch()}
          retrying={inbox.isFetching}
          className="justify-center"
        />
      </div>
    );
  }
  if (!hasContent) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const filtered = data.items.filter((item) => matchesTab(item, tab));
  const groups = groupInboxItems(filtered);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <div className="flex items-center gap-1" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={cn(
                "cursor-pointer rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground",
                tab === t.key && "bg-accent font-medium text-foreground",
              )}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* max-sm only: below the tabs' breakpoint this wraps onto a line
            of its own, where justify-between leaves it stranded at the
            left edge — every other sweep control sits on the right. */}
        <MarkAllReadButton scopeName="the inbox" className="max-sm:ml-auto" />
      </div>

      {notice && (
        <RefreshFailure
          what="the inbox"
          detail={notice}
          onRetry={() => inbox.refetch()}
          retrying={inbox.isFetching}
        />
      )}

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          收件箱清空了 🥔
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <InboxGroupSection
              key={group.project.slug}
              group={group}
              refs={refs}
            />
          ))}
        </div>
      )}

      {data.truncated && (
        <p className="text-center text-sm text-muted-foreground">
          Some projects have more unread than shown — consider marking older
          issues as read.
        </p>
      )}
    </div>
  );
}

function InboxGroupSection({
  group,
  refs,
}: {
  group: InboxGroup;
  refs: Map<string, ProjectRefOption>;
}) {
  const grid = useIssueListGrid();
  return (
    <section className="overflow-hidden rounded-lg border">
      <header className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <Link
            to="/projects/$slug"
            params={{ slug: group.project.slug }}
            className="flex items-center gap-1.5 font-semibold hover:underline"
          >
            <ProjectIcon
              project={{
                name: group.project.name,
                prefix: refs.get(group.project.slug)?.prefix ?? null,
                icon_url: group.project.icon_url,
              }}
              className="size-5"
              aria-hidden
            />
            {group.project.name}
          </Link>
          <span className="text-xs text-muted-foreground">
            {group.items.length}
          </span>
        </div>
        <MarkAllReadButton
          slug={group.project.slug}
          scopeName={group.project.name}
          compact
          className="-my-1"
        />
      </header>
      <ul className={grid}>
        {group.items.map((item) => (
          <InboxRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The shared issue row (T-118) with the inbox's own trailing pair. No meta
 * line: the row reports rather than edits, and its project — the one thing
 * the list's row never has to name — is already the section it sits in.
 */
function InboxRow({ item }: { item: InboxItem }) {
  return (
    <IssueRow
      slug={item.project.slug}
      issue={item}
      specAwaitingReview={item.pending_spec_review}
      mentionsYou={item.mentions_you}
      trailing={
        <span className="ml-auto flex shrink-0 items-center gap-2 max-sm:hidden">
          <StatusPill status={item.status} />
          <span
            className="text-xs text-muted-foreground"
            title={item.last_activity_at}
          >
            {new Date(item.last_activity_at).toLocaleString()}
          </span>
        </span>
      }
    />
  );
}
