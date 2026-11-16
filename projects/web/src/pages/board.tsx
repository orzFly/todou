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
import {
  formatRef,
  type IssueListItem,
  type IssueListPage,
  type Label,
  type Member,
  type Status,
  type Watcher,
} from "@todou/shared";
import { TagIcon, UserPlusIcon, XIcon } from "lucide-react";
import {
  memo,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { boardColumnQuery, useBoardMove } from "@/api/board.ts";
import {
  toggledById,
  useBulkIssueStatusMutation,
  useIssueAssigneesMutation,
  useIssueLabelsMutation,
} from "@/api/issues.ts";
import { useRefPlacement } from "@/api/prefs.ts";
import {
  labelsQuery,
  membersQuery,
  projectWatchersQuery,
  statusesQuery,
  useCanIfLoaded,
} from "@/api/queries.ts";
import { useRefPrefix } from "@/api/references.ts";
import { AssigneePicker } from "@/components/issue/assignee-picker.tsx";
import {
  BlockedBadge,
  QuestionBadge,
  SpecReviewBadge,
} from "@/components/issue/attention-badge.tsx";
import { BulkStatusMenu } from "@/components/issue/bulk-status-menu.tsx";
import {
  AssigneesAndWatchers,
  MetaEditButton,
} from "@/components/issue/issue-row.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import {
  LabelPicker,
  useCreateLabel,
} from "@/components/issue/label-picker.tsx";
import { MarkAllReadButton } from "@/components/issue/mark-all-read-button.tsx";
import { MarkReadButton } from "@/components/issue/mark-read-button.tsx";
import { StatusHeading } from "@/components/issue/status-pill.tsx";
import { ProjectMuteButton } from "@/components/project-mute-button.tsx";
import { ProjectWatchersChip } from "@/components/shared/project-watchers.tsx";
import {
  useRegisterReturnArea,
  useReturnLinkState,
} from "@/components/shared/return-context.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { openBlockCount } from "@/lib/blocks.ts";
import {
  BOARD_CANVAS_REGION,
  boardColumnRegion,
  WINDOW_REGION,
} from "@/lib/return-view.ts";
import { useOverlayScrollbars } from "@/lib/use-overlay-scrollbars.ts";
import { useReturnView } from "@/lib/use-return-view.ts";
import {
  groupState,
  type SelectionState,
  useSelection,
} from "@/lib/use-selection.ts";
import { cn } from "@/lib/utils";

/**
 * What a card needs to edit its own labels and assignees (T-533). Absent on
 * the drag overlay's copy, which is a picture of a card and nothing more.
 */
export type CardEdit = {
  slug: string;
  allLabels: Label[];
  members: Member[];
  onCreateLabel?: (name: string) => Promise<Label>;
  /** The server refuses labels and assignees without issue.triage. */
  canTriage: boolean;
};

type CardDragData = {
  issueNumber: number;
  fromStatusId: number;
  issue: IssueListItem;
  /** Picking up a selected card picks up the whole selection (T-708). */
  selected: boolean;
};

/**
 * The selection as the columns see it (T-708). Absent without issue.triage:
 * status is all a selection does, and the server refuses it below that role.
 */
type BoardSelect = {
  isSelected: (issueNumber: number) => boolean;
  stateOf: (issueNumbers: readonly number[]) => SelectionState;
  onSelect: (issueNumber: number, extend: boolean) => void;
  onSelectColumn: (issueNumbers: readonly number[]) => void;
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

/**
 * Every card on the board as `number:statusId`, columns left to right and
 * cards top to bottom — the order a shift-click range runs in. A string, so
 * the page re-renders only when a card arrives, leaves or moves.
 */
const boardRows = (
  results: readonly { data?: IssueListPage | undefined }[],
): string =>
  results
    .flatMap(
      (result) =>
        result.data?.items.map(
          (issue) => `${issue.number}:${issue.status.id}`,
        ) ?? [],
    )
    .join(" ");

const NO_LABELS: Label[] = [];
const NO_MEMBERS: Member[] = [];
const NO_NUMBERS: readonly number[] = [];

export function BoardPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const createLabel = useCreateLabel(slug);
  const canCreateLabels = useCanIfLoaded(slug, "label.create");
  const canTriage = useCanIfLoaded(slug, "issue.triage");
  const allLabels = useQuery(labelsQuery(slug)).data;
  const members = useQuery(membersQuery(slug)).data;
  // Stable across the page's own re-renders — a drag starting and ending is
  // two of them — so the memoized columns and cards below can skip them.
  const edit = useMemo<CardEdit>(
    () => ({
      slug,
      allLabels: allLabels ?? NO_LABELS,
      members: members ?? NO_MEMBERS,
      onCreateLabel: canCreateLabels ? createLabel : undefined,
      canTriage,
    }),
    [slug, allLabels, members, canCreateLabels, createLabel, canTriage],
  );
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
  const rowsKey = useQueries({
    queries: statuses.data.map((status) => boardColumnQuery(slug, status.id)),
    combine: boardRows,
  });
  const rows = useMemo(() => {
    const statusOf = new Map<number, number>();
    for (const row of rowsKey ? rowsKey.split(" ") : []) {
      const [number, statusId] = row.split(":").map(Number);
      statusOf.set(number as number, statusId as number);
    }
    return { numbers: [...statusOf.keys()], statusOf };
  }, [rowsKey]);
  const selection = useSelection(rows.numbers);
  // Through a ref, so the callbacks keep their identity while the selection
  // changes under them, and the memoized columns skip what they need not see.
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  });
  const onSelect = useCallback(
    (issueNumber: number, extend: boolean) =>
      selectionRef.current.toggle(issueNumber, { extend }),
    [],
  );
  const onSelectColumn = useCallback(
    (issueNumbers: readonly number[]) =>
      selectionRef.current.toggleGroup(issueNumbers),
    [],
  );
  // Keyed on what is selected rather than on the hook's own callbacks, which
  // change with every column that answers: a board loading with nothing
  // selected would otherwise re-render every column once per column.
  const selectedKey = selection.selected.join(" ");
  const select = useMemo<BoardSelect | null>(() => {
    if (!canTriage) return null;
    const picked = new Set(
      selectedKey ? selectedKey.split(" ").map(Number) : [],
    );
    return {
      isSelected: (issueNumber) => picked.has(issueNumber),
      stateOf: (issueNumbers) => groupState(picked, issueNumbers),
      onSelect,
      onSelectColumn,
    };
  }, [canTriage, selectedKey, onSelect, onSelectColumn]);
  const move = useBoardMove();
  const bulkMove = useBulkIssueStatusMutation();
  const [drag, setDrag] = useState<{
    issue: IssueListItem;
    count: number;
  } | null>(null);
  // The cards a drag carries, fixed when it starts: the selection in screen
  // order when the card picked up is part of it, that card alone otherwise.
  const dragGroup = useRef<readonly number[]>(NO_NUMBERS);
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
    if (!data) {
      dragGroup.current = NO_NUMBERS;
      setDrag(null);
      return;
    }
    dragGroup.current =
      data.selected && selection.selected.length > 1
        ? selection.selected
        : [data.issueNumber];
    setDrag({ issue: data.issue, count: dragGroup.current.length });
  }

  function onDragEnd(event: DragEndEvent) {
    const group = dragGroup.current;
    dragGroup.current = NO_NUMBERS;
    setDrag(null);
    const over = event.over;
    const data = event.active.data.current as CardDragData | undefined;
    if (!over || !data) return;
    const toStatus = statuses.data.find((s) => s.id === Number(over.id));
    if (!toStatus) return;
    if (group.length > 1) {
      // The drop names a status, not a column to leave: selected cards that
      // already sit in it stay where they are.
      const moving = group.filter(
        (issueNumber) => rows.statusOf.get(issueNumber) !== toStatus.id,
      );
      if (moving.length === 0) return;
      bulkMove.mutate({ slug, issueNumbers: moving, status: toStatus });
      selection.clear();
      return;
    }
    if (toStatus.id === data.fromStatusId) return;
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
      onDragCancel={() => {
        dragGroup.current = NO_NUMBERS;
        setDrag(null);
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {/* The board has no filter toolbar to hang this off, so it gets a
            row of its own — project-scoped, like the list's copy, because
            the endpoint sweeps a project and not a column (T-100). */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-y-2">
          <ProjectWatchersChip slug={slug} />
          <div className="me-auto flex items-center gap-2 ps-2">
            {selection.selected.length > 0 && (
              <>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {selection.selected.length} selected
                </span>
                <BulkStatusMenu
                  slug={slug}
                  statuses={statuses.data}
                  issueNumbers={selection.selected}
                  onMoved={selection.clear}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear selection"
                  title="Clear selection"
                  onClick={selection.clear}
                >
                  <XIcon />
                </Button>
              </>
            )}
          </div>
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
            <BoardColumn
              key={status.id}
              slug={slug}
              status={status}
              edit={edit}
              select={select}
            />
          ))}
        </div>
      </div>
      {/* The dragged card is rendered in an overlay because the original
          sits inside a column scroll container that would clip it as soon
          as it crosses the column edge. */}
      <DragOverlay>
        {drag && (
          <div className="relative cursor-grabbing">
            {/* The rest of the selection, as the edge of a stack under the
                card that was picked up. */}
            {drag.count > 1 && (
              <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-md border bg-background shadow-lg" />
            )}
            <div className="relative rounded-md border bg-background p-2.5 shadow-lg">
              <BoardCardContent slug={slug} issue={drag.issue} />
            </div>
            {drag.count > 1 && (
              <span
                data-testid="drag-count"
                className="absolute -top-2 -left-2 min-w-5 rounded-full bg-primary px-1.5 text-center text-xs leading-5 font-medium text-primary-foreground tabular-nums"
              >
                {drag.count}
              </span>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Memoized, with `BoardCardContent`, so a drag does not re-render the board
 * (T-691): picking a card up sets state on the page, and dnd-kit's context
 * re-renders every column and card each time the pointer crosses into
 * another column. Only the thin droppable and draggable shells take those.
 */
const BoardColumn = memo(function BoardColumn({
  slug,
  status,
  edit,
  select,
}: {
  slug: string;
  status: Status;
  edit: CardEdit;
  select: BoardSelect | null;
}) {
  const column = useQuery(boardColumnQuery(slug, status.id));
  const numbers = useMemo(
    () => column.data?.items.map((issue) => issue.number) ?? NO_NUMBERS,
    [column.data],
  );
  const columnState = select?.stateOf(numbers) ?? "none";
  // One project-wide read that every column shares, not one per card.
  const watchers = useQuery(projectWatchersQuery(slug)).data?.issues;
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
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-sm">
        {select && (
          <Checkbox
            aria-label={`select every issue in ${status.name}`}
            checked={columnState === "all"}
            indeterminate={columnState === "some"}
            disabled={numbers.length === 0}
            onChange={() => select.onSelectColumn(numbers)}
            className="shrink-0 disabled:cursor-default disabled:opacity-40"
          />
        )}
        <StatusHeading status={status} />
        <Badge variant="secondary" className="ml-auto shrink-0">
          {column.data?.items.length ?? "…"}
        </Badge>
        <span className="shrink-0 text-xs text-muted-foreground">
          {status.category}
        </span>
      </div>
      {/* The overlay scrollbars are absolutely positioned against this box, so
          it has to be `relative` and it has to hug the scroll container: given
          the whole column instead, the bar is drawn over the header row too.
          The native bar is hidden from the start rather than once the overlay
          arrives, which is an idle callback later: on a platform whose bars
          take room, the cards would otherwise narrow and widen again. */}
      <div ref={slot} className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewport}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 [scrollbar-width:none]"
        >
          {column.isPending && <Skeleton className="h-20 w-full" />}
          {column.data?.items.map((issue) => (
            <BoardCard
              key={issue.id}
              slug={slug}
              issue={issue}
              statusId={status.id}
              edit={edit}
              watchers={watchers?.[String(issue.number)]}
              selected={select?.isSelected(issue.number) ?? false}
              onSelect={select?.onSelect}
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
});

function BoardCard({
  slug,
  issue,
  statusId,
  edit,
  watchers,
  selected,
  onSelect,
}: {
  slug: string;
  issue: IssueListItem;
  statusId: number;
  edit: CardEdit;
  watchers?: Watcher[];
  selected: boolean;
  onSelect?: (issueNumber: number, extend: boolean) => void;
}) {
  const { active, attributes, listeners, setNodeRef, isDragging } =
    useDraggable({
      id: `issue-${issue.number}`,
      data: {
        issueNumber: issue.number,
        fromStatusId: statusId,
        issue,
        selected,
      } satisfies CardDragData,
    });
  // Riding along with a selected card someone else picked up. dnd-kit already
  // re-renders every draggable as a drag starts, so reading it costs nothing.
  const carried =
    selected &&
    (active?.data.current as CardDragData | undefined)?.selected === true;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "group/card cursor-grab rounded-md border bg-background p-2.5 shadow-xs",
        selected && "border-primary bg-primary/5",
        (isDragging || carried) && "opacity-30",
      )}
      // The card's own id, the same identity `key` uses above. The number is
      // a per-project address that a move between projects replaces, and a
      // snapshot outlives the board it was taken from (T-407).
      data-return-id={String(issue.id)}
    >
      <BoardCardContent
        slug={slug}
        issue={issue}
        edit={edit}
        watchers={watchers}
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}

export const BoardCardContent = memo(function BoardCardContent({
  slug,
  issue,
  edit,
  watchers = NO_WATCHERS,
  selected = false,
  onSelect,
}: {
  slug: string;
  issue: IssueListItem;
  edit?: CardEdit;
  /** This card's card-level watchers (T-540). */
  watchers?: readonly Watcher[];
  selected?: boolean;
  /** Absent where the card offers no selection; it then has no checkbox. */
  onSelect?: (issueNumber: number, extend: boolean) => void;
}) {
  const editable = edit?.canTriage ? edit : undefined;
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
    editable !== undefined ||
    onSelect !== undefined ||
    placement === "after" ||
    issue.open_questions > 0 ||
    issue.spec_review_status === "unreviewed" ||
    openBlockCount(issue.blocked_by) > 0 ||
    issue.labels.length > 0 ||
    issue.assignees.length > 0 ||
    watchers.length > 0;
  const hasAvatars = issue.assignees.length > 0 || watchers.length > 0;
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
           out of the parent's flow, so the card height is unchanged (T-361).
           The top edge does the same for the live dot and its ring, which
           reach 4px above a watching avatar (T-540): `pt-1` moves the clip
           up and `mt-0.5` is the `mt-1.5` that was there, less those 4px. */
        <div
          data-card-meta=""
          className="mt-0.5 flex flex-wrap items-center gap-1.5 overflow-hidden pt-1 pb-1 -mb-1"
        >
          {onSelect && (
            <Checkbox
              aria-label={`select ${ref}`}
              checked={selected}
              // onClick rather than onChange: only the click carries shiftKey,
              // and it fires for Space as well.
              onClick={(e) => onSelect(issue.number, e.shiftKey)}
              onChange={() => {}}
              onPointerDown={keepOffDrag}
              className="shrink-0"
            />
          )}
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
          {editable && <CardLabelEdit issue={issue} edit={editable} />}
          {/* `pr-1.5` equals the distance the bot badge extends past its
              avatar (`-right-1.5` on UserAvatar), so `ml-auto` stops the last
              avatar 6px earlier and the badge stays inside the clip. Applied
              only when the group holds an avatar, watchers included, because
              on an empty span those 6px still count as width and can push a
              label chip onto the next line (T-361). */}
          <span
            className={cn(
              "ml-auto flex items-center gap-1",
              hasAvatars && "pr-1.5",
            )}
          >
            {/* Ahead of the avatars, so the hidden icon's room does not
                push them in from the edge (T-536). */}
            {editable && <CardAssigneeEdit issue={issue} edit={editable} />}
            <AssigneesAndWatchers issue={issue} watchers={watchers} />
          </span>
        </div>
      )}
    </div>
  );
});

const NO_WATCHERS: readonly Watcher[] = [];

/**
 * The card's edit icons wait for the pointer (T-533), so a board of cards is
 * not a board of icons. Hidden by opacity rather than removed, so the card
 * does not change height under the pointer that arrives. A device that cannot
 * hover never gets the pointer there, so it always sees them; neither does a
 * keyboard, which gets them once focus is anywhere on the card.
 */
const CARD_EDIT_VISIBILITY =
  "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * Keeps a press on an edit icon from arming the card's drag: the sensor
 * listens for pointerdown on the card, and the menus open from the same
 * event. Radix composes this ahead of its own handler, which still runs.
 */
const keepOffDrag = (event: PointerEvent) => event.stopPropagation();

function CardLabelEdit({
  issue,
  edit,
}: {
  issue: IssueListItem;
  edit: CardEdit;
}) {
  const { mutate } = useIssueLabelsMutation();
  return (
    <LabelPicker
      allLabels={edit.allLabels}
      selected={issue.labels}
      onToggle={(label) =>
        mutate({
          slug: edit.slug,
          issueNumber: issue.number,
          labels: toggledById(issue.labels, label),
        })
      }
      onCreate={edit.onCreateLabel}
      trigger={
        <MetaEditButton
          label="Edit labels"
          icon={<TagIcon className="size-3.5" />}
          className={CARD_EDIT_VISIBILITY}
          onPointerDown={keepOffDrag}
        />
      }
    />
  );
}

function CardAssigneeEdit({
  issue,
  edit,
}: {
  issue: IssueListItem;
  edit: CardEdit;
}) {
  const { mutate } = useIssueAssigneesMutation();
  return (
    <AssigneePicker
      members={edit.members}
      selectedIds={issue.assignees.map((user) => user.id)}
      onToggle={(userId) => {
        const user =
          issue.assignees.find((u) => u.id === userId) ??
          edit.members.find((m) => m.user.id === userId)?.user;
        if (!user) return;
        mutate({
          slug: edit.slug,
          issueNumber: issue.number,
          assignees: toggledById(issue.assignees, user),
        });
      }}
      trigger={
        <MetaEditButton
          label="Edit assignees"
          icon={<UserPlusIcon className="size-3.5" />}
          className={cn("self-center", CARD_EDIT_VISIBILITY)}
          onPointerDown={keepOffDrag}
        />
      }
    />
  );
}
