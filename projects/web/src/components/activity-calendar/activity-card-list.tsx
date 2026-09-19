import { Link } from "@tanstack/react-router";
import { type ActivitySelection, formatRef } from "@todou/shared";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { Button } from "@/components/ui/button.tsx";

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
  const busy = loading || loadingMore;
  const hasError = error !== null;

  return (
    <section
      aria-label="Selected day activity"
      aria-busy={busy}
      className="min-w-0 max-w-full space-y-3"
    >
      {selection && (
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-medium">{selection.date}</h3>
          <p className="text-sm text-muted-foreground">
            {selection.total} active {selection.total === 1 ? "card" : "cards"}
          </p>
        </header>
      )}
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
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
      {!busy &&
        !hasError &&
        (!selection ? (
          <p className="text-sm text-muted-foreground">Select a day.</p>
        ) : selection.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active cards on {selection.date}.
          </p>
        ) : null)}
      {selection && selection.items.length > 0 && (
        <ul className="min-w-0 max-w-full space-y-2">
          {selection.items.map((card) => (
            <li
              key={`${card.project.id}:${card.issue_id}`}
              className="min-w-0 max-w-full space-y-2 rounded-lg border p-3"
            >
              <Link
                to="/projects/$slug/issues/$number"
                params={{
                  slug: card.project.slug,
                  number: String(card.number),
                }}
                className="block min-w-0 max-w-full font-medium break-words hover:underline"
              >
                {card.title}
              </Link>
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="min-w-0 max-w-full break-words">
                  {card.project.name}
                </span>
                <span className="min-w-0 max-w-full font-mono break-words">
                  {formatRef(card.project.issue_prefix, card.number)}
                </span>
                <StatusPill
                  status={card.status}
                  className="min-w-0 max-w-full break-words"
                />
                <time dateTime={card.last_active_at}>
                  {timestamp.format(new Date(card.last_active_at))}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
      {selection?.has_more && !hasError && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onLoadMore()}
        >
          Load more
        </Button>
      )}
    </section>
  );
}
