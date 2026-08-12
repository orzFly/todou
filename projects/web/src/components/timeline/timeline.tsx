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
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [newBelow, setNewBelow] = useState(false);
  const didInitialScroll = useRef(false);
  const prependAdjust = useRef<number | null>(null);

  const items: TimelineItem[] = flattenTimeline(timeline.data?.pages ?? []);
  const totalCount = items.length + pendingComments.length;

  // Bottom of the document, not of the list: the composer is sticky, and
  // the document end sits below its in-flow position — so this lands with
  // the last item fully visible above the composer.
  const scrollToBottom = useCallback(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, []);

  // Initial position: bottom of the newest page (chat-style).
  useLayoutEffect(() => {
    if (!didInitialScroll.current && totalCount > 0) {
      didInitialScroll.current = true;
      scrollToBottom();
    }
  }, [totalCount, scrollToBottom]);

  // After prepending older items, keep the viewport anchored. Consume the
  // saved height only once the backward fetch settles — the fetching-state
  // flip commits first with an unchanged document, and consuming it there
  // would leave the actual prepend uncompensated.
  useLayoutEffect(() => {
    if (prependAdjust.current !== null && !timeline.isFetchingPreviousPage) {
      const delta =
        document.documentElement.scrollHeight - prependAdjust.current;
      prependAdjust.current = null;
      if (delta > 0) window.scrollBy(0, delta);
    }
  });

  // New items at the END while following the bottom → keep following.
  // Keyed off the last item's identity, not the count: prepending older
  // pages also grows the count, and that must not announce "new below".
  const lastPending = pendingComments[pendingComments.length - 1];
  const lastItem = items[items.length - 1];
  const lastKey = lastPending
    ? `pending-${lastPending.key}`
    : lastItem
      ? `${lastItem.type}-${lastItem.id}`
      : null;
  const prevLastKey = useRef(lastKey);
  useEffect(() => {
    if (lastKey !== prevLastKey.current && prevLastKey.current !== null) {
      if (atBottomRef.current) {
        scrollToBottom();
      } else {
        setNewBelow(true);
      }
    }
    prevLastKey.current = lastKey;
  }, [lastKey, scrollToBottom]);

  // The page itself scrolls, so follow-bottom and fetch-older both hang off
  // the window scroll position. The handler reads the query through a ref
  // so it can subscribe exactly once and never miss an event.
  const timelineRef = useRef(timeline);
  useEffect(() => {
    timelineRef.current = timeline;
  });
  useEffect(() => {
    const onScroll = () => {
      const query = timelineRef.current;
      atBottomRef.current = shouldFollowBottom(
        window.scrollY,
        document.documentElement.scrollHeight,
        window.innerHeight,
      );
      if (atBottomRef.current) setNewBelow(false);

      const listTop = listRef.current?.getBoundingClientRect().top;
      if (
        listTop !== undefined &&
        listTop > -200 &&
        query.hasPreviousPage &&
        !query.isFetchingPreviousPage
      ) {
        prependAdjust.current = document.documentElement.scrollHeight;
        // Successive scroll events can outrun the isFetchingPreviousPage
        // flip; without this the second call cancels and re-issues the
        // in-flight request instead of piggybacking on it.
        query.fetchPreviousPage({ cancelRefetch: false });
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
    // Native scroll anchoring would fight the manual prepend compensation
    // above, adjusting the viewport a second time for the same insertion.
    <div
      ref={listRef}
      className="[overflow-anchor:none]"
      data-testid="timeline-scroll"
    >
      {timeline.isFetchingPreviousPage && (
        <div className="py-2 text-center text-xs text-muted-foreground">
          loading older…
        </div>
      )}
      {items.map((item) => (
        <div key={`${item.type}-${item.id}`} className="pb-2">
          {item.type === "comment" ? (
            <CommentItem
              slug={slug}
              issueNumber={issueNumber}
              comment={item}
              viewer={viewer}
            />
          ) : (
            <EventRow event={item} slug={slug} issueNumber={issueNumber} />
          )}
        </div>
      ))}
      {pendingComments.map((pending) => (
        <div key={`pending-${pending.key}`} className="pb-2">
          <CommentItem
            slug={slug}
            issueNumber={issueNumber}
            comment={pending.comment}
            pending
          />
        </div>
      ))}
      {newBelow && (
        <div className="sticky bottom-36 z-10 flex h-0 items-end justify-center">
          <Button
            size="sm"
            className="shadow-lg"
            onClick={() => {
              scrollToBottom();
              setNewBelow(false);
            }}
          >
            <ArrowDownIcon className="size-4" /> 新消息
          </Button>
        </div>
      )}
    </div>
  );
}
