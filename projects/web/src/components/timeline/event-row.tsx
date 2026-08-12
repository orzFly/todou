import { Link } from "@tanstack/react-router";
import type { TimelineEvent } from "@todou/shared";
import {
  BookOpenTextIcon,
  CheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  FileCheck2Icon,
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
    case "spec_pushed": {
      const list = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      const parts = [
        [list(payload.added), "added"],
        [list(payload.changed), "changed"],
        [list(payload.removed), "removed"],
      ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, word]) => `${n} ${word}`)
        .join(", ");
      const message =
        typeof payload.message === "string" ? ` — ${payload.message}` : "";
      return `pushed spec v${String(payload.version)} (${parts})${message}`;
    }
    case "spec_review": {
      const verdict =
        payload.verdict === "approve" ? "approved" : "requested changes on";
      const count = Number(payload.annotation_count ?? 0);
      const suffix =
        count > 0 ? ` with ${count} comment${count === 1 ? "" : "s"}` : "";
      return `${verdict} spec v${String(payload.version)}${suffix}`;
    }
    case "spec_comments_resolved": {
      const ids = payload.comment_ids as unknown[] | undefined;
      const count = ids?.length ?? 0;
      return `resolved ${count} spec comment${count === 1 ? "" : "s"}`;
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
  spec_pushed: <BookOpenTextIcon className="size-3.5" />,
  spec_review: <FileCheck2Icon className="size-3.5 text-amber-600" />,
  spec_comments_resolved: <CheckIcon className="size-3.5 text-green-600" />,
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
  // Below sm the row is plain inline flow — the whole event wraps like a
  // sentence (GitHub mobile), because truncate + title tooltip is unreadable
  // without hover. From sm up it keeps the #25 single-line grid. The {" "}
  // separators only exist for the inline mode: whitespace-only flex items
  // are never rendered, so the sm layout still spaces purely via gap.
  return (
    <div
      id={eventAnchor(event.id)}
      className="py-1.5 pl-1 text-sm text-muted-foreground sm:flex sm:items-center sm:gap-2"
    >
      <span className="inline-flex shrink-0 align-middle text-muted-foreground/70">
        {ICONS[event.event_type]}
      </span>{" "}
      <UserChip
        user={event.actor}
        nameClassName="font-medium text-foreground/80"
      />{" "}
      <AgentContextBadge
        context={event.agent_context}
        className="align-middle"
      />{" "}
      <span className="min-w-0 flex-1 sm:truncate" title={action}>
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
      </span>{" "}
      {slug !== undefined && issueNumber !== undefined ? (
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issueNumber) }}
          hash={eventAnchor(event.id)}
          hashScrollIntoView={false}
          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground/70 hover:underline"
          title={event.created_at}
        >
          {new Date(event.created_at).toLocaleString()}
        </Link>
      ) : (
        <span
          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground/70"
          title={event.created_at}
        >
          {new Date(event.created_at).toLocaleString()}
        </span>
      )}
    </div>
  );
}
