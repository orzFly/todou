import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { InboxItem } from "@todou/shared";
import { useMemo, useRef, useState } from "react";
import { groupInboxItems, type InboxGroup, inboxQuery } from "@/api/inbox.ts";
import { mutesQuery } from "@/api/mutes.ts";
import { IssueRow, useIssueListGrid } from "@/components/issue/issue-row.tsx";
import { MarkAllReadButton } from "@/components/issue/mark-all-read-button.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import {
  useCancelReturnRestore,
  useRegisterReturnArea,
  useRegisterReturnLane,
} from "@/components/shared/return-context.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectRefOption } from "@/lib/project-spellings.ts";
import { INBOX_TABS, type InboxTab, WINDOW_REGION } from "@/lib/return-view.ts";
import { useHeaderHeight } from "@/lib/use-header-height.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";
import { useReadFailure } from "@/lib/use-read-failure.ts";
import { useReturnView } from "@/lib/use-return-view.ts";
import { cn } from "@/lib/utils";

/**
 * What each tab is called. `INBOX_TABS` decides which tabs exist and in which
 * order, because a snapshot restores one by name and two lists of them would
 * drift into a tab that validates but has no button (T-407). Keyed by the
 * type, so a tab added there cannot reach this page without a word for it.
 */
const TAB_LABELS: Record<InboxTab, string> = {
  all: "All",
  comments: "Comments",
  specs: "Specs",
  questions: "Questions",
};

/**
 * The rows a reading position is remembered against (T-407), read out of the
 * DOM: it is the laid-out element the sampler measures, not the item, and the
 * rows sit inside the per-project sections rather than in one list here.
 * `data-return-id` carries an issue's database id.
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
  const { data: mutes } = useQuery(mutesQuery);
  const mutedCount =
    (mutes?.issues.length ?? 0) + (mutes?.projects.length ?? 0);
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
  const rootRef = useRef<HTMLDivElement>(null);
  const headerHeight = useHeaderHeight();
  const cancelRestore = useCancelReturnRestore();

  // Declared rather than left out, so that the inbox having no Load more is a
  // decision and not an omission somebody restores by hand: it is one payload,
  // cut by the server rather than paged.
  useRegisterReturnLane(null);
  // Opening a card from here is what takes its row out of the list — reading
  // it retires the unread reason — so the row a position was anchored to is
  // routinely gone by the time the reader returns. The candidates remembered
  // after it are what carry the restore on this page (T-407).
  useRegisterReturnArea({
    region: WINDOW_REGION,
    element: () => null,
    rows: () => returnRows(rootRef.current),
    inset: () => headerHeight,
    axis: "y",
  });
  // The tab is the one thing about this page no URL carries, by decision, so
  // the snapshot carries it instead and `applyTab` puts it back. A failed read
  // stays not ready on purpose — the restore keeps waiting, so a reader who
  // hits Retry still lands where they left off (T-407).
  useReturnView({
    target: { kind: "inbox" },
    tab,
    applyTab: setTab,
    ready: hasContent,
  });

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
    <div ref={rootRef} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <div className="flex items-center gap-1" role="tablist">
          {INBOX_TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={cn(
                "cursor-pointer rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground",
                tab === key && "bg-accent font-medium text-foreground",
              )}
              onClick={() => {
                // The reader choosing a tab outranks the one a restore is
                // still trying to put back — and the rows it would have
                // anchored to are not in this tab anyway (T-407).
                cancelRestore();
                setTab(key);
              }}
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </div>
        {/* max-sm only: below the tabs' breakpoint this wraps onto a line
            of its own, where justify-between leaves it stranded at the
            left edge — every other sweep control sits on the right. */}
        <div className="flex items-center gap-1 max-sm:ml-auto">
          <Link
            to="/inbox/muted"
            className="flex items-center gap-1.5 rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Muted
            {mutedCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {mutedCount}
              </span>
            )}
          </Link>
          <MarkAllReadButton scopeName="the inbox" />
        </div>
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
