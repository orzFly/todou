import type { TimelineEvent } from "@todou/shared";
import {
  CircleDotIcon,
  CircleSlashIcon,
  LinkIcon,
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
import { UserChip } from "@/components/shared/user-chip.tsx";

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
};

export function EventRow({
  event,
  slug,
  issueNumber,
}: {
  event: TimelineEvent;
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
  return (
    <div className="flex items-center gap-2 py-1.5 pl-1 text-sm text-muted-foreground">
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
        ) : (
          action
        )}
      </span>
      <span
        className="shrink-0 text-xs text-muted-foreground/70"
        title={event.created_at}
      >
        {new Date(event.created_at).toLocaleString()}
      </span>
    </div>
  );
}
