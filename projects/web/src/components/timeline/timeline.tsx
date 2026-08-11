import { useVirtualizer } from "@tanstack/react-virtual";
import type { TimelineComment, TimelineItem } from "@todou/shared";
import { ArrowDownIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  flattenTimeline,
  shouldFollowBottom,
  useTimeline,
} from "@/api/timeline.ts";
import {
  CommentItem,
  type Viewer,
} from "@/components/timeline/comment-item.tsx";
import { EventRow } from "@/components/timeline/event-row.tsx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function Timeline({
  slug,
  issueNumber,
  pendingComments,
  viewer = null,
}: {
  slug: string;
  issueNumber: number;
  pendingComments: Array<{ key: number; comment: TimelineComment }>;
  viewer?: Viewer | null;
}) {
  const timeline = useTimeline(slug, issueNumber);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [newBelow, setNewBelow] = useState(false);
  const didInitialScroll = useRef(false);
  const prependAdjust = useRef<number | null>(null);

  const items: TimelineItem[] = flattenTimeline(timeline.data?.pages ?? []);
  const totalCount = items.length + pendingComments.length;

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 10,
  });

  // Initial position: bottom of the newest page (chat-style).
  useLayoutEffect(() => {
    if (!didInitialScroll.current && totalCount > 0) {
      didInitialScroll.current = true;
      virtualizer.scrollToIndex(totalCount - 1, { align: "end" });
    }
  }, [totalCount, virtualizer]);

  // After prepending older items, keep the viewport anchored.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (prependAdjust.current !== null && el) {
      const delta = virtualizer.getTotalSize() - prependAdjust.current;
      prependAdjust.current = null;
      if (delta > 0) el.scrollTop += delta;
    }
  });

  // New items while following the bottom → keep following.
  const lastCount = useRef(totalCount);
  useEffect(() => {
    if (totalCount > lastCount.current) {
      if (atBottomRef.current) {
        virtualizer.scrollToIndex(totalCount - 1, { align: "end" });
      } else {
        setNewBelow(true);
      }
    }
    lastCount.current = totalCount;
  }, [totalCount, virtualizer]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = shouldFollowBottom(
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight,
    );
    if (atBottomRef.current) setNewBelow(false);

    if (
      el.scrollTop < 200 &&
      timeline.hasPreviousPage &&
      !timeline.isFetchingPreviousPage
    ) {
      prependAdjust.current = virtualizer.getTotalSize();
      timeline.fetchPreviousPage();
    }
  }, [timeline, virtualizer]);

  if (timeline.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (timeline.isError) {
    return (
      <div className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
        Failed to load timeline: {timeline.error.message}
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-[55dvh] overflow-y-auto pr-1"
        data-testid="timeline-scroll"
      >
        {timeline.isFetchingPreviousPage && (
          <div className="py-2 text-center text-xs text-muted-foreground">
            loading older…
          </div>
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const isPending = virtualRow.index >= items.length;
            const pending = isPending
              ? pendingComments[virtualRow.index - items.length]
              : undefined;
            const item = isPending ? undefined : items[virtualRow.index];
            return (
              <div
                key={
                  pending
                    ? `pending-${pending.key}`
                    : `${item?.type}-${item?.id}`
                }
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="pb-2"
              >
                {pending ? (
                  <CommentItem
                    slug={slug}
                    issueNumber={issueNumber}
                    comment={pending.comment}
                    pending
                  />
                ) : item?.type === "comment" ? (
                  <CommentItem
                    slug={slug}
                    issueNumber={issueNumber}
                    comment={item}
                    viewer={viewer}
                  />
                ) : item ? (
                  <EventRow event={item} />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {newBelow && (
        <Button
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg"
          onClick={() => {
            virtualizer.scrollToIndex(totalCount - 1, { align: "end" });
            setNewBelow(false);
          }}
        >
          <ArrowDownIcon className="size-4" /> 新消息
        </Button>
      )}
    </div>
  );
}
