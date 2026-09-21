import type { ActivitySelection } from "@todou/shared";
import { useRef } from "react";
import {
  IssueRow,
  IssueRowProjectTrailing,
  useIssueListGrid,
} from "@/components/issue/issue-row.tsx";
import { LoadMoreFooter } from "@/components/shared/load-more.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Placeholder rows for a day whose cards are still on the wire. Heights, not
 * guesses at a row's content: `h-10` and `h-11` are what the real header and
 * the real row measure, so the group the reader is about to read does not
 * move once it arrives. Widths vary because a column of identical bars reads
 * as a rendered table rather than as something still loading.
 */
const SKELETON_ROWS: { id: string; width: string }[] = [
  { id: "s1", width: "w-3/5" },
  { id: "s2", width: "w-4/5" },
  { id: "s3", width: "w-2/5" },
  { id: "s4", width: "w-3/4" },
  { id: "s5", width: "w-1/2" },
];

/** State and actions supplied by the calendar owner; this list never queries data. */
export interface ActivityCardListProps {
  /** Selected day, server total and accumulated pages in server order; null means no selection. */
  selection: ActivitySelection | null;
  /** Valid IANA timezone from the calendar response, used for every last-active timestamp. */
  timezone: string;
  /** Initial fetch or refresh. Existing cards stay mounted and actions are disabled. */
  loading?: boolean;
  /** Next-page request. Existing cards stay mounted and actions are disabled. */
  loadingMore?: boolean;
  /** Safe error text for the active request. Hides Load more; existing cards remain visible. */
  error?: string | null;
  /** Ask the parent to fetch the next cursor when selection.has_more is true. */
  onLoadMore: () => void;
  /** Retry the failed request; the parent chooses initial/refresh or next-page retry. */
  onRetry: () => void;
}

/** A selected day's minimal cards. Annual counts and history quality are intentionally omitted. */
export function ActivityCardList({
  selection,
  timezone,
  loading = false,
  loadingMore = false,
  error = null,
  onLoadMore,
  onRetry,
}: ActivityCardListProps) {
  const timestamp = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  // The same columns as the cards this list is swapped in for on the user
  // page, marker track included. The DTO carries no read state, so that track
  // stays empty here — which is exactly what an already-read card looks like
  // in the other list, and is why picking a day does not shift every title.
  const grid = useIssueListGrid();
  // This list reports its own request failures above the group, so the shared
  // footer is only ever asked for the button half.
  const focusRequested = useRef(false);
  const busy = loading || loadingMore;
  const hasError = error !== null;

  return (
    <section
      aria-label="Selected day activity"
      aria-busy={busy}
      className="min-w-0 max-w-full space-y-3"
    >
      {/* A refresh keeps the rows it already has: announcing progress is the
          screen reader's business, and taking a line for it moves the list the
          reader is pointing at. */}
      {busy && (
        <p role="status" className="sr-only">
          {loading ? "Loading activity…" : "Loading more activity…"}
        </p>
      )}
      {hasError && (
        <div role="alert" className="space-y-2 text-sm break-words">
          <p>Could not load activity: {error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onRetry()}
          >
            Retry
          </Button>
        </div>
      )}
      {!busy && !hasError && !selection && (
        <p className="text-sm text-muted-foreground">Select a day.</p>
      )}
      {/* Only with nothing to keep: a refresh over cards already on screen
          leaves them there, and swapping them for bars would take the list
          out from under a reader who is pointing at it. `aria-hidden` because
          the status line above already says what is happening. */}
      {busy && !selection && (
        <div
          aria-hidden="true"
          className="min-w-0 max-w-full overflow-hidden rounded-lg border"
        >
          <div className="flex h-10 items-center justify-between gap-2 border-b bg-muted/50 px-3.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
          {SKELETON_ROWS.map((row) => (
            <div
              key={row.id}
              className="flex h-11 items-center gap-2 border-b px-3.5 last:border-0"
            >
              <Skeleton className={cn("h-4", row.width)} />
              <Skeleton className="ml-auto h-4 w-24 max-sm:hidden" />
            </div>
          ))}
        </div>
      )}
      {/* The group survives a failed refresh: its cards and total are the last
          good answer, and dropping them would punish the reader for the retry. */}
      {selection && (
        <section className="min-w-0 max-w-full overflow-hidden rounded-lg border">
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/50 px-3.5 py-2">
            <h3 className="min-w-0 font-semibold break-words">
              {selection.date}
            </h3>
            <span className="text-xs text-muted-foreground">
              {selection.total} active{" "}
              {selection.total === 1 ? "card" : "cards"}
            </span>
          </header>
          {selection.items.length === 0 ? (
            !busy && (
              <p className="px-3.5 py-2.5 text-sm text-muted-foreground">
                No active cards on {selection.date}.
              </p>
            )
          ) : (
            <ul className={grid}>
              {selection.items.map((card) => (
                // The shared row, with every affordance it cannot back switched
                // off: this list reports what happened on a day, and has no
                // questions, spec review or blocks to offer.
                <IssueRow
                  key={`${card.project.id}:${card.issue_id}`}
                  slug={card.project.slug}
                  issue={{
                    id: card.issue_id,
                    number: card.number,
                    title: card.title,
                  }}
                  badges={false}
                  blocked={false}
                  returnAnchor={false}
                  trailing={
                    <IssueRowProjectTrailing
                      status={card.status}
                      project={{
                        name: card.project.name,
                        prefix: card.project.issue_prefix,
                      }}
                      activeAt={{
                        dateTime: card.last_active_at,
                        text: timestamp.format(new Date(card.last_active_at)),
                      }}
                    />
                  }
                />
              ))}
            </ul>
          )}
        </section>
      )}
      {selection?.has_more && !hasError && (
        <LoadMoreFooter
          pending={busy}
          error={null}
          // The shared footer reports progress by its label rather than by
          // disabling itself, so the guard against a second request lives here.
          // It also passes the click event on, and this prop takes none.
          onLoadMore={() => {
            if (!busy) onLoadMore();
          }}
          focusRequested={focusRequested}
        />
      )}
    </section>
  );
}
