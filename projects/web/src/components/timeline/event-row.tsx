import { Link } from "@tanstack/react-router";
import type { TimelineEvent } from "@todou/shared";
import {
  CircleDotIcon,
  CircleSlashIcon,
  LinkIcon,
  ListChecksIcon,
  PaperclipIcon,
  PencilIcon,
  RefreshCwIcon,
  TagIcon,
  UserMinusIcon,
  UserPlusIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { AttachmentEventLink } from "@/components/issue/attachment-list.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { splitIssueRefs } from "@/lib/issue-refs.ts";
import { commentAnchor, eventAnchor } from "@/lib/timeline-anchors.ts";

type Payload = Record<string, unknown>;

const asName = (v: unknown): string =>
  typeof v === "object" && v !== null && "name" in v
    ? String((v as { name: unknown }).name)
    : "?";

/** Human-readable line for a GitHub-style action event. Pure for tests. */
export function describeEvent(
  type: TimelineEvent["event_type"],
  payload: Payload,
): string {
  switch (type) {
    case "opened":
      return "opened this issue";
    case "closed":
      return `closed this (${asName(payload.to)})`;
    case "reopened":
      return `reopened this (${asName(payload.to)})`;
    case "status_changed":
      return `moved ${asName(payload.from)} → ${asName(payload.to)}`;
    case "title_changed":
      return `renamed "${String(payload.from)}" → "${String(payload.to)}"`;
    case "label_added":
      return `added label ${asName(payload.label)}`;
    case "label_removed":
      return `removed label ${asName(payload.label)}`;
    case "assigned": {
      const user = payload.user as { login?: string } | undefined;
      return `assigned @${user?.login ?? "?"}`;
    }
    case "unassigned": {
      const user = payload.user as { login?: string } | undefined;
      return `unassigned @${user?.login ?? "?"}`;
    }
    case "referenced":
      return `referenced by #${String(payload.by_issue)}`;
    case "attachment_added": {
      const attachment = payload.attachment as
        | { filename?: string }
        | undefined;
      return `attached ${attachment?.filename ?? "a file"}`;
    }
    case "question_answered": {
      const answers = payload.answers as unknown[] | undefined;
      const count = answers?.length ?? 0;
      return `answered ${count} question${count === 1 ? "" : "s"}`;
    }
  }
}

const ICONS: Record<TimelineEvent["event_type"], ReactNode> = {
  opened: <CircleDotIcon className="size-3.5 text-green-600" />,
  closed: <CircleSlashIcon className="size-3.5 text-purple-600" />,
  reopened: <CircleDotIcon className="size-3.5 text-green-600" />,
  status_changed: <RefreshCwIcon className="size-3.5" />,
  title_changed: <PencilIcon className="size-3.5" />,
  label_added: <TagIcon className="size-3.5" />,
  label_removed: <TagIcon className="size-3.5" />,
  assigned: <UserPlusIcon className="size-3.5" />,
  unassigned: <UserMinusIcon className="size-3.5" />,
  referenced: <LinkIcon className="size-3.5" />,
  attachment_added: <PaperclipIcon className="size-3.5" />,
  question_answered: <ListChecksIcon className="size-3.5 text-green-600" />,
};

/**
 * Replace #N tokens with issue links; the rest stays literal text.
 * `commentId` deep-links every ref to that comment's anchor — only
 * `referenced` events provide it, and they contain exactly one ref.
 */
function linkifyIssueRefs(
  text: string,
  slug: string,
  commentId?: number,
): ReactNode[] {
  return splitIssueRefs(text).map((segment, i) =>
    segment.type === "ref" ? (
      <IssueLink
        // Index keys are safe: the segments of one action string never
        // reorder.
        // biome-ignore lint/suspicious/noArrayIndexKey: static list
        key={i}
        slug={slug}
        number={segment.number}
        commentId={commentId}
      />
    ) : (
      segment.value
    ),
  );
}

export function EventRow({
  event,
  slug,
  issueNumber,
}: {
  event: TimelineEvent;
  /** Enables #N → issue link rendering; omit where there is no project. */
  slug?: string;
  issueNumber?: number;
}) {
  const action = describeEvent(event.event_type, event.payload);
  // Linkable "attached …" needs the issue's attachment query for the
  // preview modal, so it only upgrades when the context props are there.
  const attached =
    event.event_type === "attachment_added" &&
    slug !== undefined &&
    issueNumber !== undefined
      ? (event.payload.attachment as
          | { id?: number; filename?: string }
          | undefined)
      : undefined;
  // "referenced by #N" deep-links to the referencing comment when the
  // event recorded one; older events without by_comment link the issue.
  const refCommentId =
    event.event_type === "referenced" &&
    typeof event.payload.by_comment === "number"
      ? event.payload.by_comment
      : undefined;
  // "answered N questions" deep-links back to the question comment.
  const answeredCommentId =
    event.event_type === "question_answered" &&
    typeof event.payload.comment_id === "number" &&
    slug !== undefined &&
    issueNumber !== undefined
      ? event.payload.comment_id
      : undefined;
  return (
    <div
      id={eventAnchor(event.id)}
      className="flex items-center gap-2 py-1.5 pl-1 text-sm text-muted-foreground"
    >
      <span className="shrink-0 text-muted-foreground/70">
        {ICONS[event.event_type]}
      </span>
      <UserChip
        user={event.actor}
        nameClassName="font-medium text-foreground/80"
      />
      <AgentContextBadge context={event.agent_context} />
      <span className="min-w-0 flex-1 truncate" title={action}>
        {attached?.id !== undefined && slug && issueNumber ? (
          <>
            attached{" "}
            <AttachmentEventLink
              slug={slug}
              issueNumber={issueNumber}
              attachmentId={attached.id}
              filename={attached.filename ?? "a file"}
            />
          </>
        ) : answeredCommentId !== undefined && slug && issueNumber ? (
          <Link
            to="/projects/$slug/issues/$number"
            params={{ slug, number: String(issueNumber) }}
            hash={commentAnchor(answeredCommentId)}
            hashScrollIntoView={false}
            className="hover:underline"
          >
            {action}
          </Link>
        ) : slug === undefined ? (
          action
        ) : (
          linkifyIssueRefs(action, slug, refCommentId)
        )}
      </span>
      {slug !== undefined && issueNumber !== undefined ? (
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issueNumber) }}
          hash={eventAnchor(event.id)}
          hashScrollIntoView={false}
          className="shrink-0 text-xs text-muted-foreground/70 hover:underline"
          title={event.created_at}
        >
          {new Date(event.created_at).toLocaleString()}
        </Link>
      ) : (
        <span
          className="shrink-0 text-xs text-muted-foreground/70"
          title={event.created_at}
        >
          {new Date(event.created_at).toLocaleString()}
        </span>
      )}
    </div>
  );
}
