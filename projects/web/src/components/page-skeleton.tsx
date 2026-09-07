import { useMatches } from "@tanstack/react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Which shape the shell draws in `<main>` while a route's data is in flight. */
export type PageSkeletonKind =
  | "list"
  | "detail"
  | "spec"
  | "board"
  | "sections";

/**
 * What a route gets when it declares nothing: a title bar over bordered
 * blocks, which is what the settings pages, the new-issue form and the
 * project overview all look like.
 */
const DEFAULT_KIND: PageSkeletonKind = "sections";

export function PageSkeleton({ kind }: { kind: PageSkeletonKind }) {
  switch (kind) {
    case "list":
      return <ListSkeleton />;
    case "detail":
      return <DetailSkeleton />;
    case "spec":
      return <SpecSkeleton />;
    case "board":
      return <BoardSkeleton />;
    case "sections":
      return <SectionsSkeleton />;
  }
}

/**
 * The shell's Suspense fallback, and the first-paint placeholder while the
 * account is still on the wire. Both call this rather than each picking a
 * shape, so the two can never draw different things for the same route.
 *
 * The deepest declaration wins: `/projects/$slug` says `sections` for its own
 * overview, and its children override that with the shape they actually wear.
 */
export function PagePending() {
  const kind = useMatches({
    select: (matches) =>
      matches.reduce<PageSkeletonKind | undefined>(
        (deepest, match) => match.staticData.pageSkeleton ?? deepest,
        undefined,
      ),
  });
  return <PageSkeleton kind={kind ?? DEFAULT_KIND} />;
}

type SkeletonLine = { id: string; width: string };

const LIST_GROUPS: { id: string; rows: SkeletonLine[] }[] = [
  {
    id: "g1",
    rows: [
      { id: "g1r1", width: "w-3/5" },
      { id: "g1r2", width: "w-4/5" },
      { id: "g1r3", width: "w-2/5" },
    ],
  },
  {
    id: "g2",
    rows: [
      { id: "g2r1", width: "w-2/3" },
      { id: "g2r2", width: "w-1/2" },
    ],
  },
];

const TOOLBAR_CONTROLS: SkeletonLine[] = [
  { id: "t1", width: "w-16" },
  { id: "t2", width: "w-20" },
  { id: "t3", width: "w-24" },
  { id: "t4", width: "w-16" },
];

function ListSkeleton() {
  return (
    <div className="space-y-4" data-testid="page-skeleton" data-kind="list">
      {/* The `-mx-4 px-4` bleed is the filter toolbar's own (T-88); without it
          the controls would step sideways the moment the real bar arrives. */}
      <div className="-mx-4 flex flex-wrap items-center gap-2 px-4 py-1.5">
        {TOOLBAR_CONTROLS.map((control) => (
          <Skeleton key={control.id} className={cn("h-8", control.width)} />
        ))}
        <Skeleton className="ml-auto h-8 w-28" />
      </div>
      <IssueListBodySkeleton />
    </div>
  );
}

/**
 * The list shape without its toolbar — what the list page shows while a
 * filter change re-reads the groups and the toolbar itself stays put. Shared
 * with `list` rather than copied so the two cannot drift apart.
 */
export function IssueListBodySkeleton() {
  return (
    <div className="space-y-4" data-testid="issue-list-body-skeleton">
      {LIST_GROUPS.map((group) => (
        <div key={group.id}>
          <div className="flex items-center gap-2 rounded-t-lg border bg-muted px-3.5 py-2">
            <Skeleton className="size-2.5 rounded-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-6" />
          </div>
          <ul className="rounded-b-lg border border-t-0">
            {group.rows.map((row) => (
              <li
                key={row.id}
                className="grid grid-cols-[27px_1fr] items-center gap-x-2 border-b px-3.5 py-2.5 last:border-0"
              >
                <Skeleton className="size-3 justify-self-center rounded-full" />
                <div className="space-y-2">
                  <Skeleton className={cn("h-4", row.width)} />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const TIMELINE_ENTRIES: SkeletonLine[] = [
  { id: "e1", width: "w-4/5" },
  { id: "e2", width: "w-3/5" },
];

const SIDEBAR_FIELDS: SkeletonLine[] = [
  { id: "f1", width: "w-24" },
  { id: "f2", width: "w-32" },
  { id: "f3", width: "w-20" },
  { id: "f4", width: "w-28" },
];

function DetailSkeleton() {
  return (
    <div
      className="grid gap-6 lg:grid-cols-[1fr_240px]"
      data-testid="page-skeleton"
      data-kind="detail"
    >
      <div className="min-w-0 space-y-4">
        <Skeleton className="h-8 w-3/4" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="space-y-2 rounded-lg border p-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
        </div>
        <div className="space-y-4">
          {TIMELINE_ENTRIES.map((entry) => (
            <div key={entry.id} className="flex gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2 rounded-lg border p-3">
                <Skeleton className="h-3 w-40" />
                <Skeleton className={cn("h-4", entry.width)} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-4">
        {SIDEBAR_FIELDS.map((field) => (
          <div key={field.id} className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className={cn("h-4", field.width)} />
          </div>
        ))}
      </div>
    </div>
  );
}

type SpecToolbarSlot = { id: string; className: string };

/**
 * The spec toolbar's two rows, each split at its one elastic gap, every
 * placeholder as wide as the control it stands in for. The widths are here to
 * put the wrap points where the real row puts them: a placeholder is not a
 * control, so a pixel either way costs nothing, but a row that wraps one line
 * sooner than the real bar moves the whole page down when it arrives.
 */
const SPEC_TOOLBAR_ROWS: {
  id: string;
  className: string;
  left: SpecToolbarSlot[];
  right: SpecToolbarSlot[];
}[] = [
  {
    id: "a",
    // Row A's own classes, copied rather than approximated: `lg:flex-nowrap`
    // is what makes a long title truncate instead of pushing the actions onto
    // a second line (T-206), so it is also what decides this row's height.
    className: "flex flex-wrap items-center gap-2 lg:flex-nowrap",
    left: [
      { id: "back", className: "w-[62px]" },
      // Elastic, and gone below lg, like the real title.
      { id: "title", className: "hidden min-w-0 flex-1 lg:block" },
      { id: "review-status", className: "w-[103px]" },
    ],
    right: [
      // Where the file rail goes below lg, so it appears exactly where the
      // rail does not.
      { id: "files", className: "w-[87px] lg:hidden" },
      { id: "comment-file", className: "w-[102px]" },
      { id: "finish-review", className: "w-[100px]" },
    ],
  },
  {
    id: "b",
    className: "flex flex-wrap items-center gap-2",
    left: [
      { id: "view-toggle", className: "w-[125px]" },
      // shrink, like the real version and baseline triggers: line breaking
      // measures a flex item unshrunk, so this narrows them on a tight row
      // without moving the wrap point.
      { id: "version", className: "w-[119px] min-w-0 shrink" },
      { id: "compare", className: "w-7" },
      // Drawn unconditionally because arriving without search parameters
      // defaults the baseline to `version - 1`: the picker is present in
      // every state except at v1.
      { id: "baseline", className: "w-[78px] min-w-0 shrink" },
    ],
    right: [
      { id: "display-toggle", className: "w-[61px]" },
      { id: "prev", className: "w-7" },
      { id: "count", className: "w-[21px]" },
      { id: "next", className: "w-7" },
    ],
  },
];

/**
 * A fixed four, for the reason `BOARD_COLUMNS` is a fixed four: the real count
 * is in the data still loading. Four is also what a spec set usually holds —
 * proposal, design, api, plan.
 */
const SPEC_RAIL_FILES = ["r1", "r2", "r3", "r4"];

const SPEC_DOC_LINES: SkeletonLine[] = [
  { id: "d1", width: "w-full" },
  { id: "d2", width: "w-11/12" },
  { id: "d3", width: "w-4/5" },
  { id: "d4", width: "w-full" },
  { id: "d5", width: "w-3/4" },
  { id: "d6", width: "w-full" },
  { id: "d7", width: "w-5/6" },
  { id: "d8", width: "w-2/3" },
];

function SpecSkeleton() {
  return (
    <div className="space-y-4" data-testid="page-skeleton" data-kind="spec">
      {/* Not sticky, unlike the real bar: a fallback has nothing to scroll
          behind it, a sticky element occupies its in-flow space either way, and
          the real bar's `top` is a measured header height that this display-only
          component would otherwise have to go and measure. */}
      <div
        className="-mx-2 space-y-1.5 border-b px-2 py-2"
        data-testid="spec-skeleton-toolbar"
      >
        {SPEC_TOOLBAR_ROWS.map((row) => (
          <div
            key={row.id}
            className={row.className}
            data-testid="spec-skeleton-toolbar-row"
          >
            {row.left.map((slot) => (
              <Skeleton key={slot.id} className={cn("h-7", slot.className)} />
            ))}
            <span className="ml-auto" />
            {row.right.map((slot) => (
              <Skeleton key={slot.id} className={cn("h-7", slot.className)} />
            ))}
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="hidden space-y-1 lg:block">
          {SPEC_RAIL_FILES.map((file) => (
            <Skeleton
              key={file}
              className="h-7 w-full"
              data-testid="spec-skeleton-rail-file"
            />
          ))}
        </aside>
        <div className="min-w-0 space-y-4">
          <div
            className="rounded-lg border px-5 py-4"
            data-testid="spec-skeleton-doc"
          >
            <Skeleton className="h-7 w-1/2" />
            <div className="my-4 h-px bg-border" />
            <div className="space-y-2">
              {SPEC_DOC_LINES.map((line) => (
                <Skeleton key={line.id} className={cn("h-4", line.width)} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const BOARD_COLUMNS: { id: string; cards: string[] }[] = [
  { id: "c1", cards: ["c1a", "c1b", "c1c"] },
  { id: "c2", cards: ["c2a", "c2b"] },
  { id: "c3", cards: ["c3a", "c3b", "c3c"] },
  { id: "c4", cards: ["c4a"] },
];

function BoardSkeleton() {
  return (
    // The real canvas measures its own top offset and sizes itself to what is
    // left of the viewport; a fallback has no layout pass to spend on that, so
    // the height is the desktop offset (56px header + 24px of `main` padding)
    // written as a constant. A taller header makes this a few pixels long,
    // which costs a transient scrollbar and nothing else.
    <div
      className="-mb-6 mx-[calc(50%-50vw)] flex h-[calc(100dvh-5rem)] flex-col gap-4 px-4 pb-4"
      data-testid="page-skeleton"
      data-kind="board"
    >
      <div className="flex shrink-0 justify-end">
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {BOARD_COLUMNS.map((column) => (
          <div
            key={column.id}
            className="flex w-72 shrink-0 flex-col rounded-lg border bg-muted/30"
            data-testid="board-skeleton-column"
          >
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
              <Skeleton className="size-2.5 rounded-full" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="ml-auto h-4 w-6" />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">
              {column.cards.map((card) => (
                <Skeleton key={card} className="h-20 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SECTIONS: SkeletonLine[] = [
  { id: "s1", width: "w-2/3" },
  { id: "s2", width: "w-1/2" },
  { id: "s3", width: "w-3/4" },
];

function SectionsSkeleton() {
  return (
    <div
      className="space-y-10"
      data-testid="page-skeleton"
      data-kind="sections"
    >
      {SECTIONS.map((section) => (
        <section key={section.id} className="space-y-3">
          <Skeleton className="h-6 w-32" />
          <div className="space-y-2 rounded-lg border p-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className={cn("h-4", section.width)} />
          </div>
        </section>
      ))}
    </div>
  );
}
