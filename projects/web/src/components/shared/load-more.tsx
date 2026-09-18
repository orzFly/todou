import { type RefObject, useEffect, useRef } from "react";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import { Button } from "@/components/ui/button";

export function LoadMoreFailure({
  error,
  onRetry,
  retrying,
  focusRequested,
  className,
}: {
  error: Error;
  onRetry: () => void;
  retrying: boolean;
  focusRequested: RefObject<boolean>;
  className?: string;
}) {
  const failure = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (retrying || !focusRequested.current) return;
    // Narrowing can remount this row without a new click. Consume the click's
    // focus handoff once so a remount cannot take focus from the search box.
    focusRequested.current = false;
    failure.current?.querySelector<HTMLButtonElement>("button")?.focus();
  });

  return (
    <div ref={failure} className="contents">
      <LoadFailure
        message={`Could not load more: ${error.message}`}
        detail={error.message}
        onRetry={onRetry}
        retrying={retrying}
        className={className}
      />
    </div>
  );
}

export function LoadMoreFooter({
  pending,
  error,
  onLoadMore,
  focusRequested,
}: {
  pending: boolean;
  error: Error | null;
  onLoadMore: () => void;
  focusRequested: RefObject<boolean>;
}) {
  if (error) {
    return (
      <LoadMoreFailure
        error={error}
        onRetry={onLoadMore}
        retrying={pending}
        focusRequested={focusRequested}
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
