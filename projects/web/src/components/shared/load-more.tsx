import { LoadFailure } from "@/components/shared/load-failure.tsx";
import { Button } from "@/components/ui/button";

export function LoadMoreFailure({
  error,
  onRetry,
  retrying,
  className,
}: {
  error: Error;
  onRetry: () => void;
  retrying: boolean;
  className?: string;
}) {
  return (
    <LoadFailure
      message={`Could not load more: ${error.message}`}
      detail={error.message}
      onRetry={onRetry}
      retrying={retrying}
      autoFocus
      className={className}
    />
  );
}

export function LoadMoreFooter({
  pending,
  error,
  onLoadMore,
}: {
  pending: boolean;
  error: Error | null;
  onLoadMore: () => void;
}) {
  if (error) {
    return (
      <LoadMoreFailure
        error={error}
        onRetry={onLoadMore}
        retrying={pending}
        className="justify-center"
      />
    );
  }

  return (
    <div className="text-center">
      <Button variant="outline" size="sm" onClick={onLoadMore}>
        {pending ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
