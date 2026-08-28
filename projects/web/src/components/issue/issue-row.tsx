import { Link } from "@tanstack/react-router";
import {
  formatRef,
  type IssueListItem,
  type Label,
  type Status,
} from "@todou/shared";
import { CheckIcon, TagIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useRefPlacement } from "@/api/prefs.ts";
import { useRefPrefix } from "@/api/references.ts";
import {
  QuestionBadge,
  SpecReviewBadge,
} from "@/components/issue/attention-badge.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import { LabelPicker } from "@/components/issue/label-picker.tsx";
import { MarkReadButton } from "@/components/issue/mark-read-button.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
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
 */
const ISSUE_LIST_GRID = "grid grid-cols-[27px_max-content_1fr] gap-x-2 px-3.5";

/**
 * The same list with the ref trailing its title instead (T-153): no ref
 * column at all. Emptying the track is not the same thing — a collapsed
 * max-content track still leaves its two gaps behind, doubling the space
 * between the marker and the title.
 */
const ISSUE_LIST_GRID_TRAILING_REF = "grid grid-cols-[27px_1fr] gap-x-2 px-3.5";

/** The column layout a list of `IssueRow`s must wear, per the viewer's preference. */
export function useIssueListGrid(): string {
  return useRefPlacement("list") === "before"
    ? ISSUE_LIST_GRID
    : ISSUE_LIST_GRID_TRAILING_REF;
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
export function IssueRow({
  slug,
  issue,
  specAwaitingReview = issue.spec_review_status === "unreviewed",
  trailing,
  meta,
}: {
  slug: string;
  issue: IssueListItem;
  /**
   * Whether a spec is waiting on the viewer. The inbox overrides the default
   * with the server's caller-aware flag, which also excludes versions the
   * viewer pushed themselves — not derivable from `spec_review_status`.
   */
  specAwaitingReview?: boolean;
  trailing?: ReactNode;
  meta?: ReactNode;
}) {
  const refPrefix = useRefPrefix(slug);
  const refLeads = useRefPlacement("list") === "before";
  const ref = formatRef(refPrefix, issue.number);
  return (
    <li
      className={cn(
        ISSUE_LIST_ROW,
        "grid grid-cols-subgrid items-center border-b px-3.5 py-2.5 transition-colors last:border-0 hover:bg-muted/50",
      )}
    >
      {/* Centering keeps the ring and the 99+ badge on one axis; the width of
          the slot is the grid's first column (the CLI's ● column). */}
      <span className="inline-flex justify-center">
        <MarkReadButton
          slug={slug}
          number={issue.number}
          unread={issue.unread}
          unreadComments={issue.unread_comments}
        />
      </span>
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
        {issue.open_questions > 0 && (
          <QuestionBadge count={issue.open_questions} className="shrink-0" />
        )}
        {specAwaitingReview && (
          <SpecReviewBadge version={issue.spec_version} className="shrink-0" />
        )}
        {trailing}
      </div>
      {meta && (
        <div
          className={cn(
            "mt-1 flex flex-wrap items-center gap-1.5",
            refLeads ? "col-start-3" : "col-start-2",
          )}
        >
          {meta}
        </div>
      )}
    </li>
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
  onStatus,
  onToggleLabel,
  onCreateLabel,
}: {
  issue: IssueListItem;
  statuses: Status[];
  allLabels: Label[];
  onStatus: (status: Status) => void;
  onToggleLabel: (label: Label) => void;
  onCreateLabel?: (name: string) => Promise<Label>;
}) {
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
      <LabelChips labels={issue.labels} />
      <LabelPicker
        allLabels={allLabels}
        selected={issue.labels}
        onToggle={onToggleLabel}
        onCreate={onCreateLabel}
        trigger={
          <button
            type="button"
            className="flex cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <TagIcon className="size-3.5" aria-label="edit labels" />
          </button>
        }
      />
      <span className="flex-1" />
      <span className="flex gap-1">
        {issue.assignees.map((user) => (
          <UserChip key={user.id} user={user} compact />
        ))}
      </span>
    </>
  );
}
