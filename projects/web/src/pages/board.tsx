import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { formatRef, type IssueListItem, type Status } from "@todou/shared";
import { useEffect, useRef, useState } from "react";
import { boardColumnQuery, useBoardMove } from "@/api/board.ts";
import { useRefPlacement } from "@/api/prefs.ts";
import { statusesQuery } from "@/api/queries.ts";
import { useRefPrefix } from "@/api/references.ts";
import {
  BlockedBadge,
  QuestionBadge,
  SpecReviewBadge,
} from "@/components/issue/attention-badge.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import { MarkAllReadButton } from "@/components/issue/mark-all-read-button.tsx";
import { MarkReadButton } from "@/components/issue/mark-read-button.tsx";
import { ProjectMuteButton } from "@/components/project-mute-button.tsx";
import {
  useRegisterReturnArea,
  useReturnLinkState,
} from "@/components/shared/return-context.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { openBlockCount } from "@/lib/blocks.ts";
import {
  BOARD_CANVAS_REGION,
  boardColumnRegion,
  WINDOW_REGION,
} from "@/lib/return-view.ts";
import { useOverlayScrollbars } from "@/lib/use-overlay-scrollbars.ts";
import { useReturnView } from "@/lib/use-return-view.ts";
import { cn } from "@/lib/utils";

type CardDragData = {
  issueNumber: number;
  fromStatusId: number;
  issue: IssueListItem;
};

/**
 * The rows of one scrolling region, read out of the DOM in display order
 * (T-407). Restoring a position means measuring boxes, so the rows have to be
 * the elements that exist rather than the query data behind them.
 *
 * `root` is the scrolling element itself and never the document, so nothing
 * drawn outside the region can end up as one of its rows — `<DragOverlay/>`
 * holds a copy of the dragged card in a fixed box of its own for as long as a
 * drag lasts.
 */
function returnRowsIn(
  root: HTMLElement | null,
  selector: string,
): { id: string; element: HTMLElement }[] {
  if (root === null) return [];
  const rows: { id: string; element: HTMLElement }[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const id = element.dataset.returnId;
    if (id !== undefined) rows.push({ id, element });
  }
  return rows;
}

/**
 * Whether every column has answered. The restore waits for this because a
 * `scrollTop` written before the cards render lands on a box of zero height,
 * which the browser clamps back to 0 (T-407).
 *
 * A column that answered with an error counts: it has no cards to measure and
 * will never have any, and waiting on it would leave every other column at the
 * top too.
 *
 * Declared outside the component so the identity react-query memoizes against
 * stays the same between renders.
 */
const everyColumnAnswered = (
  results: readonly { isPending: boolean }[],
): boolean => results.every((result) => !result.isPending);

export function BoardPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const canvas = useRef<HTMLDivElement>(null);
  useRegisterReturnArea({
    region: BOARD_CANVAS_REGION,
    element: () => canvas.current,
    // Direct children only. Cards carry the same attribute, and every card in
    // here sits inside one of these columns, so an unscoped query would offer
    // the canvas a card as the column to come back to.
    rows: () => returnRowsIn(canvas.current, ":scope > [data-return-id]"),
    axis: "x",
  });
  useRegisterReturnArea({
    region: WINDOW_REGION,
    element: () => null,
    // The document scroll has nothing to anchor against: what overflows it is
    // the board as a single block, and the columns all start at the same
    // height, so a remembered pixel says as much as any row could.
    rows: () => [],
  });
  const columnsAnswered = useQueries({
    queries: statuses.data.map((status) => boardColumnQuery(slug, status.id)),
    combine: everyColumnAnswered,
  });
  // No filters and no pagination, so the address is the whole target and no
  // lane is registered. What the board does have is the scrolling regions
  // above, which the columns extend with one apiece.
  useReturnView({
    target: { kind: "board", slug },
    ready: columnsAnswered,
  });
  const move = useBoardMove();
  const [activeIssue, setActiveIssue] = useState<IssueListItem | null>(null);
  // Require a small drag distance so plain clicks still navigate.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  // The click fired after a drop would natively navigate the title link:
  // dnd-kit only stops the click's propagation (React handlers never run,
  // so the Link can't preventDefault), and an anchor's default action does
  // not need propagation to complete. Window capture is the one spot that
  // runs before dnd-kit's document-capture listener, so cancel it there.
  const dragHappened = useRef(false);
  useEffect(() => {
    const reset = () => {
      dragHappened.current = false;
    };
    const swallowPostDragClick = (event: MouseEvent) => {
      if (dragHappened.current) {
        dragHappened.current = false;
        event.preventDefault();
      }
    };
    window.addEventListener("pointerdown", reset, { capture: true });
    window.addEventListener("click", swallowPostDragClick, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", reset, { capture: true });
      window.removeEventListener("click", swallowPostDragClick, {
        capture: true,
      });
    };
  }, []);

  function onDragStart(event: DragStartEvent) {
    dragHappened.current = true;
    const data = event.active.data.current as CardDragData | undefined;
    setActiveIssue(data?.issue ?? null);
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveIssue(null);
    const over = event.over;
    const data = event.active.data.current as CardDragData | undefined;
    if (!over || !data) return;
    const toStatus = statuses.data.find((s) => s.id === Number(over.id));
    if (!toStatus || toStatus.id === data.fromStatusId) return;
    move.mutate({
      slug,
      issueNumber: data.issueNumber,
      fromStatusId: data.fromStatusId,
      toStatus,
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveIssue(null)}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {/* The board has no filter toolbar to hang this off, so it gets a
            row of its own — project-scoped, like the list's copy, because
            the endpoint sweeps a project and not a column (T-100). */}
        <div className="flex shrink-0 justify-end">
          <MarkAllReadButton slug={slug} scopeName="this project" />
          <ProjectMuteButton slug={slug} />
        </div>
        {/* 240px is the floor a cramped window degrades against: this row
            bursts the canvas and overflows visibly, so the page scrolls
            instead of the columns being crushed to nothing. */}
        <div
          ref={canvas}
          className="flex min-h-60 flex-1 gap-4 overflow-x-auto"
        >
          {statuses.data.map((status) => (
            <BoardColumn key={status.id} slug={slug} status={status} />
          ))}
        </div>
      </div>
      {/* The dragged card is rendered in an overlay because the original
          sits inside a column scroll container that would clip it as soon
          as it crosses the column edge. */}
      <DragOverlay>
        {activeIssue && (
          <div className="cursor-grabbing rounded-md border bg-background p-2.5 shadow-lg">
            <BoardCardContent slug={slug} issue={activeIssue} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({ slug, status }: { slug: string; status: Status }) {
  const column = useQuery(boardColumnQuery(slug, status.id));
  const { setNodeRef, isOver } = useDroppable({ id: status.id });
  const { slot, viewport } = useOverlayScrollbars(column.data !== undefined);
  // The column registers its own scrolling region because the page above it
  // never holds this element (T-407). `viewport` and not `slot`: overlay
  // scrollbars adopt this div rather than inserting one of their own, so its
  // `scrollTop` is the reader's position whether or not the instance exists
  // yet, while `slot` only hosts the drawn bars and never scrolls.
  useRegisterReturnArea({
    region: boardColumnRegion(status.id),
    element: () => viewport.current,
    rows: () => returnRowsIn(viewport.current, "[data-return-id]"),
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border bg-muted/30",
        isOver && "ring-2 ring-ring",
      )}
      data-testid={`column-${status.name}`}
      // The id and not the name `data-testid` carries above: a renamed status
      // is still the column the canvas has to find again (T-407).
      data-return-id={String(status.id)}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {/* The name is the only part that may give ground: without shrink-0 on
            the other three, a long status name squeezes the count badge into an
            ellipsis instead of truncating itself (T-303). */}
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: status.color }}
          aria-hidden
        />
        <span className="min-w-0 truncate text-sm font-medium">
          {status.name}
        </span>
        <Badge variant="secondary" className="ml-auto shrink-0">
          {column.data?.items.length ?? "…"}
        </Badge>
        <span className="shrink-0 text-xs text-muted-foreground">
          {status.category}
        </span>
      </div>
      {/* The overlay scrollbars are absolutely positioned against this box, so
          it has to be `relative` and it has to hug the scroll container: given
          the whole column instead, the bar is drawn over the header row too. */}
      <div ref={slot} className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewport}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
        >
          {column.isPending && <Skeleton className="h-20 w-full" />}
          {column.data?.items.map((issue) => (
            <BoardCard
              key={issue.id}
              slug={slug}
              issue={issue}
              statusId={status.id}
            />
          ))}
          {column.data?.items.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              empty
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BoardCard({
  slug,
  issue,
  statusId,
}: {
  slug: string;
  issue: IssueListItem;
  statusId: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `issue-${issue.number}`,
    data: {
      issueNumber: issue.number,
      fromStatusId: statusId,
      issue,
    } satisfies CardDragData,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "cursor-grab rounded-md border bg-background p-2.5 shadow-xs",
        isDragging && "opacity-30",
      )}
      // The card's own id, the same identity `key` uses above. The number is
      // a per-project address that a move between projects replaces, and a
      // snapshot outlives the board it was taken from (T-407).
      data-return-id={String(issue.id)}
    >
      <BoardCardContent slug={slug} issue={issue} />
    </div>
  );
}

export function BoardCardContent({
  slug,
  issue,
}: {
  slug: string;
  issue: IssueListItem;
}) {
  const refPrefix = useRefPrefix(slug);
  const placement = useRefPlacement("board");
  const ref = formatRef(refPrefix, issue.number);
  // The board this card was opened from, carried as history state on the
  // navigation itself (T-407). It has to ride the link rather than a handler:
  // the post-drag suppression above works by cancelling the click's default
  // action, and a handler that ran before that point would navigate on a drop.
  const returnState = useReturnLinkState();
  // Only `after` seats the ref on the meta row; under the other two a plain
  // card has nothing left to put there, and an empty flex row still spends
  // its top margin.
  const showMeta =
    placement === "after" ||
    issue.open_questions > 0 ||
    issue.spec_review_status === "unreviewed" ||
    openBlockCount(issue.blocked_by) > 0 ||
    issue.labels.length > 0 ||
    issue.assignees.length > 0;
  return (
    <div className="relative">
      {issue.unread && (
        /* Negative offsets keep the marker itself where the plain marker
           sat; the 24px hit target grows outward over the card padding
           instead of crowding the title. */
        <span className="absolute -top-2 -right-2 inline-flex">
          <MarkReadButton
            slug={slug}
            number={issue.number}
            unread={issue.unread}
            unreadComments={issue.unread_comments}
            muted={issue.muted}
          />
        </span>
      )}
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug, number: String(issue.number) }}
        state={returnState}
        className={cn(
          // `anywhere` rather than `break-word` because this component is also
          // mounted in the DragOverlay and could land in any shrink-to-fit
          // box, where `break-word` stops taking effect (T-303).
          "block wrap-anywhere text-sm font-medium hover:underline",
          // The 99+ badge is ~27px wide; the ring only needs the old dot gap.
          issue.unread_comments > 0 ? "pr-8" : issue.unread && "pr-4",
        )}
      >
        {placement === "before" && (
          <span className="font-normal text-muted-foreground">{ref} </span>
        )}
        {issue.title}
      </Link>
      {/* Its own line sits outside the link: the ref reads as a caption under
          the title rather than as more of its click target. */}
      {placement === "own_line" && (
        <div className="mt-0.5 text-xs text-muted-foreground">{ref}</div>
      )}
      {/* Meta row hosts the question badge; the card's top-right corner
          belongs to the unread marker above (T-46, T-77). */}
      {showMeta && (
        /* Clipped, not wrapped: everything on this row is a nowrap chip that
           reads worse broken mid-token than cut at the card edge (T-303).
           `overflow-hidden` clips at the padding box, so `pb-1` moves the
           lower clip edge down by the distance UserAvatar's bot badge extends
           below the avatar (`-bottom-1` there). `-mb-1` takes those 4px back
           out of the parent's flow, so the card height is unchanged (T-361). */
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 overflow-hidden pb-1 -mb-1">
          {placement === "after" && (
            <span className="text-xs text-muted-foreground">{ref}</span>
          )}
          {issue.open_questions > 0 && (
            <QuestionBadge
              slug={slug}
              issueNumber={issue.number}
              count={issue.open_questions}
            />
          )}
          {issue.spec_review_status === "unreviewed" && (
            <SpecReviewBadge
              slug={slug}
              issueNumber={issue.number}
              version={issue.spec_version}
            />
          )}
          <BlockedBadge slug={slug} blockedBy={issue.blocked_by} />
          <LabelChips labels={issue.labels} />
          {/* `pr-1.5` equals the distance the bot badge extends past its
              avatar (`-right-1.5` on UserAvatar), so `ml-auto` stops the last
              avatar 6px earlier and the badge stays inside the clip. Applied
              only when there are assignees, because on an empty span those
              6px still count as width and can push a label chip onto the
              next line (T-361). */}
          <span
            className={cn(
              "ml-auto flex gap-1",
              issue.assignees.length > 0 && "pr-1.5",
            )}
          >
            {issue.assignees.map((user) => (
              <UserChip key={user.id} user={user} compact />
            ))}
          </span>
        </div>
      )}
    </div>
  );
}
