import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { InboxItem } from "@todou/shared";
import { useState } from "react";
import { groupInboxItems, type InboxGroup, inboxQuery } from "@/api/inbox.ts";
import { IssueRow } from "@/components/issue/issue-row.tsx";
import { MarkAllReadButton } from "@/components/issue/mark-all-read-button.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { Skeleton } from "@/components/ui/skeleton";
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
  const [tab, setTab] = useState<InboxTab>("all");

  if (inbox.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (inbox.isError) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-destructive">
          Could not load the inbox: {inbox.error.message}
        </p>
        <button
          type="button"
          className="mt-3 text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => inbox.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }

  const filtered = inbox.data.items.filter((item) => matchesTab(item, tab));
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

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          收件箱清空了 🥔
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <InboxGroupSection key={group.project.slug} group={group} />
          ))}
        </div>
      )}

      {inbox.data.truncated && (
        <p className="text-center text-sm text-muted-foreground">
          Some projects have more unread than shown — consider marking older
          issues as read.
        </p>
      )}
    </div>
  );
}

function InboxGroupSection({ group }: { group: InboxGroup }) {
  return (
    <section className="overflow-hidden rounded-lg border">
      <header className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3.5 py-2">
        <div className="flex items-baseline gap-2">
          <Link
            to="/projects/$slug"
            params={{ slug: group.project.slug }}
            className="font-semibold hover:underline"
          >
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
      <ul>
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
