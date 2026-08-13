import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatRef, type InboxItem } from "@todou/shared";
import { useState } from "react";
import { groupInboxItems, type InboxGroup, inboxQuery } from "@/api/inbox.ts";
import { useRefPrefix } from "@/api/references.ts";
import { MarkReadButton } from "@/components/issue/mark-read-button.tsx";
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
        {/* T-100 (bulk mark-as-read): the global "Mark all read" button
            lands here, wired to PUT /me/read with no projects filter. */}
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
  const refPrefix = useRefPrefix(group.project.slug);
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
        {/* T-100 (bulk mark-as-read): the per-project "mark project read"
            button lands here, wired to PUT /me/read {projects: [slug]}. */}
      </header>
      <ul>
        {group.items.map((item) => (
          <InboxRow key={item.id} item={item} refPrefix={refPrefix} />
        ))}
      </ul>
    </section>
  );
}

function InboxRow({
  item,
  refPrefix,
}: {
  item: InboxItem;
  refPrefix: string | null;
}) {
  const slug = item.project.slug;
  return (
    <li className="border-b px-3.5 py-2.5 transition-colors last:border-0 hover:bg-muted/50">
      <div className="flex items-center gap-2">
        {/* Same fixed-width marker slot as the issue list (T-77 sizing). */}
        <span className="inline-flex w-[27px] shrink-0 justify-center">
          <MarkReadButton
            slug={slug}
            number={item.number}
            unread={item.unread}
            unreadComments={item.unread_comments}
          />
        </span>
        <span className="w-11 shrink-0 text-[13px] text-muted-foreground tabular-nums max-sm:w-auto">
          {formatRef(refPrefix, item.number)}
        </span>
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(item.number) }}
          className="min-w-0 truncate font-medium hover:underline"
        >
          {item.title}
        </Link>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {item.pending_spec_review && item.spec_version !== null && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              spec v{item.spec_version} awaiting review
            </span>
          )}
          {item.open_questions > 0 && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-400">
              {item.open_questions === 1
                ? "question waiting"
                : `${item.open_questions} questions waiting`}
            </span>
          )}
          <StatusPill status={item.status} className="max-sm:hidden" />
          <span
            className="text-xs text-muted-foreground max-sm:hidden"
            title={item.last_activity_at}
          >
            {new Date(item.last_activity_at).toLocaleString()}
          </span>
        </span>
      </div>
    </li>
  );
}
