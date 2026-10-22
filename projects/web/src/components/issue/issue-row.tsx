import { Link } from "@tanstack/react-router";
import {
  formatRef,
  type IssueListItem,
  type Label,
  type Member,
  type Status,
  type Watcher,
} from "@todou/shared";
import { CheckIcon, EyeIcon, TagIcon, UserPlusIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useRefPlacement } from "@/api/prefs.ts";
import { useRefPrefix } from "@/api/references.ts";
import { AssigneePicker } from "@/components/issue/assignee-picker.tsx";
import {
  BlockedBadge,
  MentionBadge,
  QuestionBadge,
  SpecReviewBadge,
} from "@/components/issue/attention-badge.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import { LabelPicker } from "@/components/issue/label-picker.tsx";
import { MarkReadButton } from "@/components/issue/mark-read-button.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { groupWatchers } from "@/components/shared/watcher-stack.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The columns of a list of `IssueRow`s — read marker, ref, everything else —
 * carried by the `<ul>` so that the ref column is sized by the longest ref in
 * the whole list. A per-row slot cannot do that: inside the 44px one this
 * replaces, `CH-113` wrapped onto two lines and `REFRACT-` overflowed onto
 * the title (T-155). Rows opt into the columns with `grid-cols-subgrid`.
 *
 * The list also owns the rows' horizontal padding, because a subgrid's own
 * padding is subtracted from its first and last track — 14px of padding on
 * the row itself would leave the 27px marker column 13px wide. Rows take that
 * padding back through `ISSUE_LIST_ROW`.
 *
 * The flexible track is `minmax(0,1fr)`, not `1fr`: `1fr` means
 * `minmax(auto, 1fr)`, and that `auto` floor is the widest min-content in the
 * track. One unbreakable label chip is enough to push the track past the
 * container, and since nothing above the list clips, the whole page scrolls
 * sideways (T-306). The floor also decides whether the title's own `truncate`
 * ever fires: in an over-wide track it has room to spare and never ellipsises.
 */
const ISSUE_LIST_GRID =
  "grid grid-cols-[27px_max-content_minmax(0,1fr)] gap-x-2 px-3.5";

/**
 * The same list with the ref trailing its title instead (T-153): no ref
 * column at all. Emptying the track is not the same thing — a collapsed
 * max-content track still leaves its two gaps behind, doubling the space
 * between the marker and the title.
 */
const ISSUE_LIST_GRID_TRAILING_REF =
  "grid grid-cols-[27px_minmax(0,1fr)] gap-x-2 px-3.5";

/**
 * The same two layouts without the read marker's track. A list that only
 * reports has no read state to offer, and leaving the 27px column empty would
 * indent every title past a control that is not there.
 */
const ISSUE_LIST_GRID_NO_MARKER =
  "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 px-3.5";
const ISSUE_LIST_GRID_NO_MARKER_TRAILING_REF =
  "grid grid-cols-[minmax(0,1fr)] gap-x-2 px-3.5";

/**
 * The column layout a list of `IssueRow`s must wear, per the viewer's
 * preference. `readMarker: false` must match the rows' own prop: the track and
 * the control are one decision, made once by the list.
 */
export function useIssueListGrid({
  readMarker = true,
}: {
  readMarker?: boolean;
} = {}): string {
  const leads = useRefPlacement("list") === "before";
  if (!readMarker) {
    return leads
      ? ISSUE_LIST_GRID_NO_MARKER
      : ISSUE_LIST_GRID_NO_MARKER_TRAILING_REF;
  }
  return leads ? ISSUE_LIST_GRID : ISSUE_LIST_GRID_TRAILING_REF;
}

/**
 * Every `<li>` of such a list, row or not: one full-width cell, bleeding back
 * over the list's padding so borders and hover still reach its edges.
 */
export const ISSUE_LIST_ROW = "col-span-full -mx-3.5";

/**
 * One issue row, worn by the project list and the cross-project inbox alike
 * (T-118). The identity line — read marker, ref, title link, attention
 * badges — is the same on both pages; only what hangs off it differs, so the
 * differences are slots rather than a variant flag:
 *
 * - `trailing` closes the identity line (inbox: status and last activity).
 * - `meta` is a second line indented under the title (list: the status menu,
 *   labels and assignees). Omitted → the row stays one line tall.
 *
 * `slug` comes per row, not from a page-level context: the inbox mixes
 * projects, and every link, ref prefix and mark-read call is project-scoped.
 */
/**
 * What a row cannot do without. Everything behind an affordance is optional,
 * so a list that switches those affordances off can hand over the three facts
 * it actually has instead of inventing read state and empty label arrays.
 */
export type IssueRowIssue = Pick<IssueListItem, "id" | "number" | "title"> &
  Partial<
    Pick<
      IssueListItem,
      | "unread"
      | "unread_comments"
      | "muted"
      | "open_questions"
      | "spec_version"
      | "spec_review_status"
      | "blocked_by"
    >
  >;

export function IssueRow({
  slug,
  issue,
  specAwaitingReview = issue.spec_review_status === "unreviewed",
  mentionsYou = false,
  trailing,
  meta,
  readMarker = true,
  badges = true,
  blocked = true,
  returnAnchor = true,
}: {
  slug: string;
  issue: IssueRowIssue;
  /**
   * Whether a spec is waiting on the viewer. The inbox overrides the default
   * with the server's caller-aware flag, which also excludes versions the
   * viewer pushed themselves — not derivable from `spec_review_status`.
   */
  specAwaitingReview?: boolean;
  /** The viewer was @-mentioned on this card (T-373). */
  mentionsYou?: boolean;
  trailing?: ReactNode;
  meta?: ReactNode;
  /** The ● column. Off for a list with no read state; pair with the grid's own flag. */
  readMarker?: boolean;
  /** Open questions, spec review and mention badges. */
  badges?: boolean;
  /** The blocked-by badge. */
  blocked?: boolean;
  /**
   * Whether this row is a place a returning reader can be put back on. Only
   * the list a page is *about* may claim that: a second list of the same cards
   * would offer the restorer two anchors carrying one id.
   */
  returnAnchor?: boolean;
}) {
  const refPrefix = useRefPrefix(slug);
  const refLeads = useRefPlacement("list") === "before";
  const ref = formatRef(refPrefix, issue.number);
  const returnState = useReturnLinkState();
  return (
    <li
      // The anchor a returning reader is put back on (T-407). The database id
      // rather than the number, because a move rewrites the number and the
      // remembered anchor would then name a different card — or none.
      data-return-id={returnAnchor ? String(issue.id) : undefined}
      className={cn(
        ISSUE_LIST_ROW,
        "grid grid-cols-subgrid items-center border-b px-3.5 py-2.5 transition-colors last:border-0 hover:bg-muted/50",
      )}
    >
      {/* Centering keeps the ring and the 99+ badge on one axis; the width of
          the slot is the grid's first column (the CLI's ● column). */}
      {readMarker && (
        <span className="inline-flex justify-center">
          <MarkReadButton
            slug={slug}
            number={issue.number}
            unread={issue.unread ?? false}
            unreadComments={issue.unread_comments ?? 0}
            muted={issue.muted ?? null}
          />
        </span>
      )}
      {refLeads && (
        /* The old fixed width survives as a floor, so a project whose refs fit
           within it keeps the spacing it had. */
        <span className="min-w-11 whitespace-nowrap text-[13px] text-muted-foreground tabular-nums max-sm:min-w-0">
          {ref}
        </span>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issue.number) }}
          state={returnState}
          className="min-w-0 truncate font-medium hover:underline"
        >
          {issue.title}
        </Link>
        {!refLeads && (
          /* Trailing, the ref loses its own column, so it defends its width
             here instead: a long title truncates, the ref never does. */
          <span className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground tabular-nums">
            {ref}
          </span>
        )}
        {/* Reasons hug the title, exactly as on a board card; only `trailing`
            is pushed to the far edge, so a badge never ends up inside a group
            the phone hides (T-116). */}
        {badges && (issue.open_questions ?? 0) > 0 && (
          <QuestionBadge
            slug={slug}
            issueNumber={issue.number}
            count={issue.open_questions ?? 0}
            className="shrink-0"
          />
        )}
        {badges && specAwaitingReview && (
          <SpecReviewBadge
            slug={slug}
            issueNumber={issue.number}
            version={issue.spec_version ?? null}
            className="shrink-0"
          />
        )}
        {badges && mentionsYou && <MentionBadge className="shrink-0" />}
        {blocked && (
          <BlockedBadge
            slug={slug}
            blockedBy={issue.blocked_by ?? []}
            className="shrink-0"
          />
        )}
        {trailing}
      </div>
      {meta && (
        <div
          className={cn(
            "mt-1 flex flex-wrap items-center gap-1.5",
            // One track earlier when the marker's column is not there.
            readMarker
              ? refLeads
                ? "col-start-3"
                : "col-start-2"
              : refLeads
                ? "col-start-2"
                : "col-start-1",
          )}
        >
          {meta}
        </div>
      )}
    </li>
  );
}

/**
 * What closes a row in a list that spans projects: what the card is doing,
 * and where it lives.
 *
 * One component rather than one spelling per list, because the user page's
 * two lists stand in the same slot — picking a day on the calendar swaps that
 * day's cards in for "Their cards" — and two orderings of these same three
 * things would read as the rows themselves changing shape when a day is
 * picked.
 *
 * The status pill survives the phone; the project is hidden there instead of
 * shrunk, because what is left of a name at phone width is a letter and a
 * half.
 *
 * The group does not shrink, and the project name is capped rather than left
 * to take whatever the name happens to be: the row's flexible space belongs
 * to the title, and a shrinkable group divides it in proportion instead, which
 * on a long title cut `Refract Engine` down to `F`. What the cap gives up is
 * the tail of an unusually long name; the title keeps the room.
 */
export function IssueRowProjectTrailing({
  status,
  project,
  activeAt,
}: {
  status: Pick<Status, "name" | "color">;
  project: { name: string; prefix: string | null; icon_url?: string | null };
  /** Last activity, for the list whose group is a date rather than a person. */
  activeAt?: { dateTime: string; text: string };
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      <StatusPill status={status} className="shrink-0" />
      <span className="flex max-w-40 items-center gap-2 max-sm:hidden">
        <ProjectIcon
          project={project}
          className="size-5 shrink-0"
          aria-hidden
        />
        {/* No `min-w-0`: `truncate` brings `overflow-hidden`, which already
            resolves this flex item's `min-width: auto` to 0. */}
        <span className="truncate">{project.name}</span>
      </span>
      {activeAt && (
        <time className="shrink-0" dateTime={activeAt.dateTime}>
          {activeAt.text}
        </time>
      )}
    </span>
  );
}

/**
 * The editable second line: status menu, labels, assignees. Split from the
 * row so pages that only report — the inbox — pay for none of the mutation
 * machinery.
 */
export function IssueRowMeta({
  issue,
  statuses,
  allLabels,
  members,
  onStatus,
  onToggleLabel,
  onCreateLabel,
  onToggleAssignee,
  watchers,
}: {
  issue: IssueListItem;
  statuses: Status[];
  allLabels: Label[];
  /** What the assignee menu offers; only read with `onToggleAssignee`. */
  members?: Member[];
  /** Absent where the viewer may not assign; the avatars stay as display. */
  onToggleAssignee?: (userId: number) => void;
  onStatus: (status: Status) => void;
  onToggleLabel: (label: Label) => void;
  onCreateLabel?: (name: string) => Promise<Label>;
  /** This card's card-level watchers (T-540); the inbox and user page pass none. */
  watchers?: readonly Watcher[];
}) {
  const hasAvatars = issue.assignees.length > 0 || (watchers?.length ?? 0) > 0;
  return (
    <>
      <DropdownMenu>
        {/* flex collapses the button's line box to the pill; the default
            block box is 24px tall and seats the pill on its text baseline,
            ~1.6px below the neighbouring label chips (T-98). */}
        <DropdownMenuTrigger className="flex cursor-pointer">
          <StatusPill status={issue.status} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {statuses.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => onStatus(s)}>
              <span className="w-4">
                {s.id === issue.status.id && <CheckIcon className="size-4" />}
              </span>
              <StatusPill status={s} className="border-0 px-0" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The one thing on this line that can give ground: the status pill's
          width comes from the project's status list, the tag icon is 14px,
          and the title sits on the line above with its own truncate. */}
      <LabelChips labels={issue.labels} truncate />
      <LabelPicker
        allLabels={allLabels}
        selected={issue.labels}
        onToggle={onToggleLabel}
        onCreate={onCreateLabel}
        trigger={
          <MetaEditButton
            label="Edit labels"
            icon={<TagIcon className="size-3.5" />}
          />
        }
      />
      {/* The icon leads the avatars: the group is pushed to the right edge,
          so anything after the last avatar moves every avatar left (T-536).
          `ml-auto` rather than a spacer keeps the group on that edge when it
          wraps to its own line on a phone, as on a board card. */}
      <span className="ml-auto flex items-center gap-1">
        {onToggleAssignee && (
          <AssigneePicker
            members={members ?? []}
            selectedIds={issue.assignees.map((user) => user.id)}
            onToggle={onToggleAssignee}
            trigger={
              <MetaEditButton
                label="Edit assignees"
                icon={<UserPlusIcon className="size-3.5" />}
                className={cn(hasAvatars && "mr-1")}
              />
            }
          />
        )}
        <AssigneesAndWatchers issue={issue} watchers={watchers} />
      </span>
    </>
  );
}

/**
 * The avatars of a row's assignee group (T-540). A watching assignee gets
 * the live dot on the avatar it already has; watchers nobody assigned follow
 * behind an eye that stays visible, because the edit icon ahead of the
 * assignees is hover-only on the board and cannot separate the two groups.
 */
export function AssigneesAndWatchers({
  issue,
  watchers = [],
}: {
  issue: Pick<IssueListItem, "assignees">;
  watchers?: readonly Watcher[];
}) {
  const watching = new Set(watchers.map((watcher) => watcher.user.id));
  const assigned = new Set(issue.assignees.map((user) => user.id));
  const others = groupWatchers(watchers).filter(
    (group) => !assigned.has(group.user.id),
  );
  return (
    <>
      {issue.assignees.map((user) => (
        <UserChip
          key={user.id}
          user={user}
          compact
          live={watching.has(user.id)}
        />
      ))}
      {others.length > 0 && (
        <>
          <EyeIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground",
              issue.assignees.length > 0 && "ml-1",
            )}
          />
          {others.map((group) => (
            <UserChip key={group.user.id} user={group.user} compact live />
          ))}
        </>
      )}
    </>
  );
}

/**
 * The 14px icon that opens a picker from a list row or a board card. Props
 * are spread because Radix's `asChild` hands its trigger the handlers, ref
 * and open state that way. The hit area grows past the icon through a
 * pseudo-element, so a finger gets a target without the line growing.
 */
export function MetaEditButton({
  label,
  icon,
  className,
  ...props
}: ComponentProps<"button"> & { label: string; icon: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "relative flex cursor-pointer text-muted-foreground hover:text-foreground",
        "after:absolute after:-inset-1.5 pointer-coarse:after:-inset-2.5",
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
}
