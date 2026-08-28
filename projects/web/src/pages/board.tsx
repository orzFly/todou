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
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { formatRef, type IssueListItem, type Status } from "@todou/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { boardColumnQuery, useBoardMove } from "@/api/board.ts";
import { useRefPlacement } from "@/api/prefs.ts";
import { statusesQuery } from "@/api/queries.ts";
import { useRefPrefix } from "@/api/references.ts";
import {
  QuestionBadge,
  SpecReviewBadge,
} from "@/components/issue/attention-badge.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import { MarkAllReadButton } from "@/components/issue/mark-all-read-button.tsx";
import { MarkReadButton } from "@/components/issue/mark-read-button.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type CardDragData = {
  issueNumber: number;
  fromStatusId: number;
  issue: IssueListItem;
};

export function BoardPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const move = useBoardMove(slug);
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

  // Size the canvas to the viewport space below it so the page itself never
  // scrolls and each column scrolls on its own. The offset above the canvas
  // (the app header) isn't knowable in CSS, so measure it.
  const canvasRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fitCanvas = () => {
      const top = canvas.getBoundingClientRect().top;
      // Floor so a cramped window degrades to a scrolling page instead of
      // crushing the columns to nothing.
      const height = Math.max(window.innerHeight - top, 240);
      canvas.style.height = `${height}px`;
    };
    fitCanvas();
    window.addEventListener("resize", fitCanvas);
    // Re-measure when content above the canvas reflows (e.g. the mobile
    // header nav wrapping differently). Writing the same height back does
    // not re-trigger the observer, so this settles instead of looping.
    const observer = new ResizeObserver(fitCanvas);
    observer.observe(document.body);
    return () => {
      window.removeEventListener("resize", fitCanvas);
      observer.disconnect();
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
      {/* Negative horizontal margins escape the shell's centered max-w
          container so the multi-column board can use the full viewport
          width; -mb-6 swallows the shell's bottom padding so the measured
          height lands exactly on the viewport edge. */}
      <div
        ref={canvasRef}
        className="mx-[calc(50%-50vw)] -mb-6 flex flex-col gap-4 px-4 pb-4"
      >
        {/* The board has no filter toolbar to hang this off, so it gets a
            row of its own — project-scoped, like the list's copy, because
            the endpoint sweeps a project and not a column (T-100). */}
        <div className="flex shrink-0 justify-end">
          <MarkAllReadButton slug={slug} scopeName="this project" />
        </div>
        <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto">
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

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border bg-muted/30",
        isOver && "ring-2 ring-ring",
      )}
      data-testid={`column-${status.name}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span
          className="size-2.5 rounded-full"
          style={{ backgroundColor: status.color }}
          aria-hidden
        />
        <span className="text-sm font-medium">{status.name}</span>
        <Badge variant="secondary" className="ml-auto">
          {column.data?.items.length ?? "…"}
        </Badge>
        <span className="text-xs text-muted-foreground">{status.category}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
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
  // Only `after` seats the ref on the meta row; under the other two a plain
  // card has nothing left to put there, and an empty flex row still spends
  // its top margin.
  const showMeta =
    placement === "after" ||
    issue.open_questions > 0 ||
    issue.spec_review_status === "unreviewed" ||
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
          />
        </span>
      )}
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug, number: String(issue.number) }}
        className={cn(
          "block text-sm font-medium hover:underline",
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
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {placement === "after" && (
            <span className="text-xs text-muted-foreground">{ref}</span>
          )}
          {issue.open_questions > 0 && (
            <QuestionBadge count={issue.open_questions} />
          )}
          {issue.spec_review_status === "unreviewed" && (
            <SpecReviewBadge version={issue.spec_version} />
          )}
          <LabelChips labels={issue.labels} />
          <span className="ml-auto flex gap-1">
            {issue.assignees.map((user) => (
              <UserChip key={user.id} user={user} compact />
            ))}
          </span>
        </div>
      )}
    </div>
  );
}
