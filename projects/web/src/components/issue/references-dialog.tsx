import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { IssueReferenceEntry } from "@todou/shared";
import { type MouseEvent, type ReactNode, useMemo } from "react";
import { issueReferencesQuery } from "@/api/issue-references.ts";
import { projectsQuery } from "@/api/queries.ts";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { commentAnchor } from "@/lib/timeline-anchors.ts";

const keyOf = (e: IssueReferenceEntry) => `${e.project_id}/${e.number}`;

/**
 * Every card linking to this one and every card it links to (T-553), from
 * the sidebar's More actions menu.
 */
export function IssueReferencesDialog({
  slug,
  issueNumber,
  open,
  onOpenChange,
}: {
  slug: string;
  issueNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const references = useQuery({
    ...issueReferencesQuery(slug, issueNumber),
    enabled: open,
  });
  const projects = useQuery(projectsQuery);
  const slugById = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.slug])),
    [projects.data],
  );
  const data = references.data;
  const both = useMemo(() => {
    if (!data) return new Set<string>();
    const to = new Set(data.links_to.map(keyOf));
    return new Set(data.linked_from.map(keyOf).filter((k) => to.has(k)));
  }, [data]);

  // Moving between cards keeps the issue route mounted, so the dialog would
  // stay open over the card it just took the reader to. A modified click is
  // opening a tab in the background and leaves the reader where they are.
  const closeOnFollow = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (!(event.target as Element).closest?.("a[href]")) return;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
        aria-describedby={undefined}
        onClickCapture={closeOnFollow}
      >
        <DialogHeader>
          <DialogTitle>All references</DialogTitle>
        </DialogHeader>
        {references.isError ? (
          <LoadFailure
            message="Failed to load references."
            detail={references.error.message}
            onRetry={() => references.refetch()}
            retrying={references.isFetching}
          />
        ) : (
          <div className="space-y-4">
            <Section
              title="Linked from"
              entries={data?.linked_from}
              render={(entry) => (
                <Row
                  entry={entry}
                  slug={slugById.get(entry.project_id)}
                  pageSlug={slug}
                  both={both.has(keyOf(entry))}
                  commentOn={{
                    slug: slugById.get(entry.project_id),
                    number: entry.number,
                  }}
                />
              )}
            />
            <Section
              title="Links to"
              entries={data?.links_to}
              render={(entry) => (
                <Row
                  entry={entry}
                  slug={slugById.get(entry.project_id)}
                  pageSlug={slug}
                  both={both.has(keyOf(entry))}
                  commentOn={{ slug, number: issueNumber }}
                />
              )}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  entries,
  render,
}: {
  title: string;
  entries: IssueReferenceEntry[] | undefined;
  render: (entry: IssueReferenceEntry) => ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1.5 text-sm font-medium">
        {title}
        {entries && (
          <>
            {" "}
            <span className="ml-0.5 text-muted-foreground">
              {entries.length}
            </span>
          </>
        )}
      </h3>
      {entries === undefined ? (
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">None</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {entries.map((entry) => (
            <li key={keyOf(entry)} className="flex items-baseline gap-2">
              {render(entry)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  entry,
  slug,
  pageSlug,
  both,
  commentOn,
}: {
  entry: IssueReferenceEntry;
  /** Undefined when the reader cannot read the card's project. */
  slug: string | undefined;
  pageSlug: string;
  both: boolean;
  /** The card whose comment holds the link. */
  commentOn: { slug: string | undefined; number: number };
}) {
  return (
    <>
      <span className="min-w-0">
        {slug === undefined ? (
          <span className="text-muted-foreground italic">
            a card you cannot see
          </span>
        ) : (
          <IssueLink slug={slug} number={entry.number} pageSlug={pageSlug} />
        )}
      </span>
      {both && (
        <span
          className="shrink-0 text-muted-foreground"
          title="Links both ways"
          role="img"
          aria-label="Links both ways"
        >
          ⇄
        </span>
      )}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {entry.comment_id === null ? (
          "body"
        ) : commentOn.slug === undefined ? (
          "comment"
        ) : (
          <Link
            to="/projects/$slug/issues/$number"
            params={{
              slug: commentOn.slug,
              number: String(commentOn.number),
            }}
            hash={commentAnchor(entry.comment_id)}
            className="hover:underline"
          >
            comment
          </Link>
        )}
        {entry.more > 0 && ` +${entry.more}`}
      </span>
    </>
  );
}
