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
  mergeFolded,
  needsHead,
  remainingCount,
  shouldFollowBottom,
  useTimelineHead,
  useTimelineTail,
} from "@/api/timeline.ts";
import {
  CommentItem,
  type Viewer,
} from "@/components/timeline/comment-item.tsx";
import { EventRow } from "@/components/timeline/event-row.tsx";
import { FoldBlock } from "@/components/timeline/fold-block.tsx";
import { SpecVersionCard } from "@/components/timeline/spec-version-card.tsx";
import { useTimelineAnchor } from "@/components/timeline/use-timeline-anchor.ts";
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
  const tail = useTimelineTail(slug, issueNumber);
  const headEnabled = needsHead(tail.data?.pages[0]);
  const head = useTimelineHead(slug, issueNumber, headEnabled);
  const atBottomRef = useRef(true);
  const [newBelow, setNewBelow] = useState(false);
  const didInitialScroll = useRef(false);
  const blockRef = useRef<HTMLDivElement>(null);
  // Chunk-insert compensation, captured at click time (T-30): the document
  // height baseline plus the adaptive verdict — block in the upper half of
  // the viewport means the reader came up from the tail, so the tail side
  // stays glued; lower half means the head side is being read, and content
  // above the seam is naturally stable without adjustment.
  const chunkAdjust = useRef<{ base: number; compensate: boolean } | null>(
    null,
  );
  const lastScrollHeight = useRef(0);
  const prevAboveCount = useRef(0);

  const { above, below } = mergeFolded(
    headEnabled ? (head.data?.pages ?? []) : [],
    tail.data?.pages ?? [],
  );
  const totalCount = tail.data?.pages.at(-1)?.total_count ?? 0;
  const remaining =
    headEnabled && head.data ? remainingCount(totalCount, above, below) : 0;
  const items: TimelineItem[] = [...above, ...below];
  const renderedCount = items.length + pendingComments.length;

  // Bottom of the document, not of the list: the composer is sticky, and
  // the document end sits below its in-flow position — so this lands with
  // the last item fully visible above the composer.
  const scrollToBottom = useCallback(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, []);

  // A #comment-/#event- anchor takes over positioning (scroll + flash,
  // expanding the folded middle as needed) — see use-timeline-anchor.ts.
  const anchorActive = useTimelineAnchor({
    remaining,
    isExpanding:
      tail.isPending ||
      (headEnabled && head.isPending) ||
      head.isFetchingNextPage,
    // Anchor-driven expansion skips the compensation: the document stays
    // anchored above the seam while chunks stream in, and the final
    // scrollIntoView owns the viewport once the target renders.
    expand: () => head.fetchNextPage({ cancelRefetch: false }),
  });

  // Initial position: bottom of the newest page (chat-style), unless an
  // anchor target owns the viewport.
  useLayoutEffect(() => {
    if (!didInitialScroll.current && renderedCount > 0) {
      didInitialScroll.current = true;
      if (!anchorActive) scrollToBottom();
    }
  }, [renderedCount, scrollToBottom, anchorActive]);

  // Insertions above the viewport must not shift what the reader sees.
  useLayoutEffect(() => {
    const doc = document.documentElement;
    // The head mounting under an already-positioned viewport (bottom or
    // anchor) is a prepend — keep the tail side glued, unconditionally.
    if (above.length > 0 && prevAboveCount.current === 0) {
      const delta = doc.scrollHeight - lastScrollHeight.current;
      if (delta > 0) window.scrollBy(0, delta);
    }
    // Chunk insert settled — apply the verdict captured at click time.
    // Consume only once the fetch settles: the fetching-state flip commits
    // first with an unchanged document, and consuming it there would leave
    // the actual insert uncompensated.
    if (chunkAdjust.current !== null && !head.isFetchingNextPage) {
      const { base, compensate } = chunkAdjust.current;
      chunkAdjust.current = null;
      const delta = doc.scrollHeight - base;
      if (compensate && delta > 0) window.scrollBy(0, delta);
    }
    prevAboveCount.current = above.length;
    lastScrollHeight.current = doc.scrollHeight;
  });

  // New items at the END while following the bottom → keep following.
  // Keyed off the last item's identity, not the count: expanding the fold
  // also grows the count, and that must not announce "new below".
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

  // The page itself scrolls, so follow-bottom hangs off the window scroll
  // position. (Scroll-to-top no longer loads anything: the head is present
  // from the start, and the fold block is the only gap-filling affordance.)
  useEffect(() => {
    const onScroll = () => {
      atBottomRef.current = shouldFollowBottom(
        window.scrollY,
        document.documentElement.scrollHeight,
        window.innerHeight,
      );
      if (atBottomRef.current) setNewBelow(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const onLoadMore = useCallback(() => {
    const blockTop =
      blockRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    chunkAdjust.current = {
      base: document.documentElement.scrollHeight,
      compensate: blockTop < window.innerHeight / 2,
    };
    // Successive clicks can outrun the isFetchingNextPage flip; without
    // this the second call cancels and re-issues the in-flight request
    // instead of piggybacking on it.
    head.fetchNextPage({ cancelRefetch: false });
  }, [head.fetchNextPage]);

  const renderItem = (item: TimelineItem) => (
    <div key={`${item.type}-${item.id}`} className="pb-2">
      {item.type === "comment" ? (
        <CommentItem
          slug={slug}
          issueNumber={issueNumber}
          comment={item}
          viewer={viewer}
        />
      ) : (
        <>
          <EventRow event={item} slug={slug} issueNumber={issueNumber} />
          {item.event_type === "spec_pushed" && (
            <SpecVersionCard
              slug={slug}
              issueNumber={issueNumber}
              payload={item.payload}
            />
          )}
        </>
      )}
    </div>
  );

  if (tail.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (tail.isError || head.isError) {
    return (
      <div className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
        Failed to load timeline: {(tail.error ?? head.error)?.message}
      </div>
    );
  }

  return (
    // Native scroll anchoring would fight the manual insert compensation
    // above, adjusting the viewport a second time for the same insertion.
    <div className="[overflow-anchor:none]" data-testid="timeline-scroll">
      {headEnabled && head.isPending && (
        <div className="space-y-3 pb-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {above.map(renderItem)}
      {remaining > 0 && (
        <div ref={blockRef} className="pb-2">
          <FoldBlock
            remaining={remaining}
            loading={head.isFetchingNextPage}
            onLoadMore={onLoadMore}
          />
        </div>
      )}
      {below.map(renderItem)}
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
