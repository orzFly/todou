import { Link } from "@tanstack/react-router";
import {
  formatRef,
  type IssueListItem,
  type Label,
  type Status,
} from "@todou/shared";
import { CheckIcon, TagIcon } from "lucide-react";
import type { ReactNode } from "react";
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
  return (
    <li className="border-b px-3.5 py-2.5 transition-colors last:border-0 hover:bg-muted/50">
      <div className="flex items-center gap-2">
        {/* Fixed-width slot (the CLI's ● column, sized for the 99+ badge)
            keeps numbers from shifting; centering keeps the ring and the
            badge on one axis. */}
        <span className="inline-flex w-[27px] shrink-0 justify-center">
          <MarkReadButton
            slug={slug}
            number={issue.number}
            unread={issue.unread}
            unreadComments={issue.unread_comments}
          />
        </span>
        <span className="w-11 shrink-0 text-[13px] text-muted-foreground tabular-nums max-sm:w-auto">
          {formatRef(refPrefix, issue.number)}
        </span>
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issue.number) }}
          className="min-w-0 truncate font-medium hover:underline"
        >
          {issue.title}
        </Link>
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
      {/* pl mirrors line 1: unread slot 27 + gap 8 (+ ref 44 when it is
          fixed-width, ≥sm only) so the meta line starts under the title. */}
      {meta && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[79px] max-sm:pl-[35px]">
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
