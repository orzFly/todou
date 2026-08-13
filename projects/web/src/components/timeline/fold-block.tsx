import { Button } from "@/components/ui/button";

/**
 * The folded-middle divider (T-30), GitHub-style: sits in the seam between
 * the rendered head and tail, names what is hidden, and expands one chunk
 * per click.
 */
export function FoldBlock({
  remaining,
  loading,
  onLoadMore,
}: {
  remaining: number;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2 border-y py-5"
      data-testid="fold-block"
    >
      <span className="text-sm font-medium text-muted-foreground">
        {remaining} remaining item{remaining === 1 ? "" : "s"}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={onLoadMore}
      >
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
