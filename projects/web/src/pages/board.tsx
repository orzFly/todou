import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { IssueListItem, Status } from "@todou/shared";
import { useEffect, useRef } from "react";
import { boardColumnQuery, useBoardMove } from "@/api/board.ts";
import { statusesQuery } from "@/api/queries.ts";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { NewIssueDialog } from "@/components/issue/new-issue-dialog.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function BoardPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const move = useBoardMove(slug);
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

  function onDragEnd(event: DragEndEvent) {
    const over = event.over;
    const data = event.active.data.current as
      | { issueNumber: number; fromStatusId: number }
      | undefined;
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
      onDragStart={() => {
        dragHappened.current = true;
      }}
      onDragEnd={onDragEnd}
    >
      {/* Negative margins escape the shell's centered max-w container so
          the multi-column board can use the full viewport width. */}
      <div className="mx-[calc(50%-50vw)] space-y-4 px-4">
        <div className="flex justify-end">
          <NewIssueDialog slug={slug} statuses={statuses.data} />
        </div>
        <div className="flex gap-4 overflow-x-auto pb-4">
          {statuses.data.map((status) => (
            <BoardColumn key={status.id} slug={slug} status={status} />
          ))}
        </div>
      </div>
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
      <div className="flex items-center gap-2 border-b px-3 py-2">
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
      <div className="flex min-h-24 flex-col gap-2 p-2">
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
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `issue-${issue.number}`,
      data: { issueNumber: issue.number, fromStatusId: statusId },
    });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={
        transform
          ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
          : undefined
      }
      className={cn(
        "cursor-grab rounded-md border bg-background p-2.5 shadow-xs",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug, number: String(issue.number) }}
        className="block text-sm font-medium hover:underline"
      >
        {issue.title}
      </Link>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">#{issue.number}</span>
        {issue.labels.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
        <span className="ml-auto flex gap-1">
          {issue.assignees.map((user) => (
            <UserChip key={user.id} user={user} compact />
          ))}
        </span>
      </div>
    </div>
  );
}
