import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  formatRef,
  resolveSlugAt,
  type SlugClaimEntry,
  type TimelineEvent,
} from "@todou/shared";
import {
  ArchiveRestoreIcon,
  BookOpenTextIcon,
  CheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  FileCheck2Icon,
  LinkIcon,
  ListChecksIcon,
  LogInIcon,
  LogOutIcon,
  PaperclipIcon,
  PencilIcon,
  RefreshCwIcon,
  TagIcon,
  Trash2Icon,
  UserMinusIcon,
  UserPlusIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { projectsQuery } from "@/api/queries.ts";
import {
  refConfigFor,
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "@/api/references.ts";
import { AttachmentEventLink } from "@/components/issue/attachment-list.tsx";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  type EventEntities,
  resolveLabel,
  resolveStatus,
  resolveUser,
  useEventEntities,
} from "@/components/timeline/use-event-entities.ts";
import { type RefConfig, splitIssueRefs } from "@/lib/issue-refs.ts";
import { commentAnchor, eventAnchor } from "@/lib/timeline-anchors.ts";

/** Entity emphasis inside an event sentence, one notch below the actor's. */
export const IN_SENTENCE = "font-medium text-foreground/75";

export type EventRenderContext = {
  /** Enables #N → issue link rendering; omit where there is no project. */
  slug?: string;
  issueNumber?: number;
  refConfig: RefConfig;
  /** Slug claims, so a cross-reference resolves as of the event (T-156). */
  slugEntries: SlugClaimEntry[];
  /** Project id → current slug, preferred over the payload's slug. */
  slugOfProject?: (id: number) => string | undefined;
  entities: EventEntities;
};

export function useEventRenderContext(
  slug?: string,
  issueNumber?: number,
): EventRenderContext {
  // UI strings spell refs in the project's current format (T-80); the
  // query no-ops (enabled: false) in project-less contexts.
  const refConfigData = useQuery({
    ...referenceConfigQuery(slug ?? ""),
    enabled: slug !== undefined,
  });
  const directory = useQuery(referenceDirectoryQuery);
  const projects = useQuery(projectsQuery);
  const entities = useEventEntities(slug);
  const slugById = useMemo(() => {
    const map = new Map<number, string>();
    for (const project of projects.data ?? [])
      map.set(project.id, project.slug);
    return map;
  }, [projects.data]);
  return {
    slug,
    issueNumber,
    refConfig: refConfigFor(refConfigData.data),
    slugEntries: directory.data?.slug_entries ?? [],
    slugOfProject: (id) => slugById.get(id),
    entities,
  };
}

/**
 * The one place a timeline event turns into a row. `node` is the rich
 * rendering and `text` its plain-text mirror (tooltip, truncation, tests);
 * both leave the same switch, so neither can drift from the other.
 *
 * Entities render through the same components as the rest of the app —
 * statuses as pills, labels as chips, users as chips — resolved against
 * current project metadata rather than the payload snapshot (see
 * use-event-entities).
 */
export function renderEvent(
  event: TimelineEvent,
  ctx: EventRenderContext,
): { node: ReactNode; text: string } {
  const { payload } = event;
  const { entities } = ctx;
  const seg = (text: string, commentId?: number): ReactNode =>
    ctx.slug === undefined
      ? text
      : linkifyIssueRefs(text, ctx.slug, ctx.refConfig, commentId);
  const plain = (text: string, commentId?: number) => ({
    node: seg(text, commentId),
    text,
  });

  switch (event.event_type) {
    case "opened":
      return plain("opened this issue");
    case "closed":
    case "reopened": {
      const verb = event.event_type === "closed" ? "closed" : "reopened";
      const status = resolveStatus(payload.to, entities.statusById);
      return {
        node: (
          <>
            {`${verb} this `}
            <StatusPill status={status} className="align-middle" />
          </>
        ),
        // Parentheses are the plain-text stand-in for the pill's outline.
        text: `${verb} this (${status.name})`,
      };
    }
    case "status_changed": {
      const from = resolveStatus(payload.from, entities.statusById);
      const to = resolveStatus(payload.to, entities.statusById);
      return {
        node: (
          <>
            {"moved "}
            <StatusPill status={from} className="align-middle" />
            {" → "}
            <StatusPill status={to} className="align-middle" />
          </>
        ),
        text: `moved ${from.name} → ${to.name}`,
      };
    }
    case "title_changed": {
      const from = String(payload.from);
      const to = String(payload.to);
      return {
        node: (
          <>
            {"renamed "}
            <span className="text-muted-foreground/60 line-through">
              {seg(from)}
            </span>{" "}
            <span className={IN_SENTENCE}>{seg(to)}</span>
          </>
        ),
        // The arrow carries in text what the strike-through carries visually.
        text: `renamed "${from}" → "${to}"`,
      };
    }
    case "label_added":
    case "label_removed": {
      const verb = event.event_type === "label_added" ? "added" : "removed";
      const label = resolveLabel(payload.label, entities.labelById);
      return {
        node: (
          <>
            {`${verb} label `}
            <LabelChip label={label} className="align-middle" />
          </>
        ),
        text: `${verb} label ${label.name}`,
      };
    }
    case "assigned":
    case "unassigned": {
      const verb = event.event_type === "assigned" ? "assigned" : "unassigned";
      const { user, text } = resolveUser(payload.user, entities.memberById);
      return {
        node: (
          <>
            {`${verb} `}
            {user ? (
              <span className="inline-flex align-middle">
                <UserChip user={user} nameClassName={IN_SENTENCE} />
              </span>
            ) : (
              <span className={IN_SENTENCE}>{text}</span>
            )}
          </>
        ),
        text: `${verb} ${text}`,
      };
    }
    case "referenced": {
      // Deep-links to the referencing comment when the event recorded one;
      // older events without by_comment link the issue.
      const commentId =
        typeof payload.by_comment === "number" ? payload.by_comment : undefined;
      return plain(
        `referenced by ${formatRef(ctx.refConfig.internalPrefix, Number(payload.by_issue))}`,
        commentId,
      );
    }
    case "cross_referenced": {
      const project = payload.by_project;
      const number = payload.by_issue;
      // A row a move rewrote stays visible with its far side blanked; it was
      // visible before the move, and losing it would be the disappearance
      // the redaction rule exists to prevent.
      if (payload.by_moved === true && project === null) {
        return plain("referenced by a card that has since moved");
      }
      // Self-contained on purpose: the source lives in another project, so
      // this project's format would spell a number that means nothing here.
      const text = `referenced by ${String(project)}#${String(number)}`;
      if (typeof project !== "string" || typeof number !== "number")
        return plain(text);
      // An id beats a slug: a slug has to be read as of the event's own
      // instant, and after it changes hands that answer is a guess.
      const byId =
        typeof payload.by_project_id === "number"
          ? ctx.slugOfProject?.(payload.by_project_id)
          : undefined;
      const slug =
        byId ??
        resolveSlugAt(ctx.slugEntries, [], project, event.created_at) ??
        project;
      return {
        node: (
          <>
            {"referenced by "}
            <IssueLink
              slug={slug}
              number={number}
              crossProject
              fallback={`${slug}#${number}`}
            />
          </>
        ),
        text,
      };
    }
    case "attachment_added": {
      const attachment = payload.attachment as
        | { id?: number; filename?: string }
        | undefined;
      const filename = attachment?.filename ?? "a file";
      const text = `attached ${filename}`;
      // The preview modal needs the issue's attachment query, so the link
      // only appears where the context props are there.
      if (
        attachment?.id === undefined ||
        ctx.slug === undefined ||
        ctx.issueNumber === undefined
      )
        return plain(text);
      return {
        node: (
          <>
            {"attached "}
            <AttachmentEventLink
              slug={ctx.slug}
              issueNumber={ctx.issueNumber}
              attachmentId={attachment.id}
              filename={filename}
            />
          </>
        ),
        text,
      };
    }
    case "question_answered": {
      const answers = payload.answers as unknown[] | undefined;
      const count = answers?.length ?? 0;
      const text = `answered ${count} question${count === 1 ? "" : "s"}`;
      const commentId =
        typeof payload.comment_id === "number" ? payload.comment_id : undefined;
      if (
        commentId === undefined ||
        ctx.slug === undefined ||
        ctx.issueNumber === undefined
      )
        return plain(text);
      return {
        node: (
          <Link
            to="/projects/$slug/issues/$number"
            params={{ slug: ctx.slug, number: String(ctx.issueNumber) }}
            hash={commentAnchor(commentId)}
            hashScrollIntoView={false}
            className="hover:underline"
          >
            {text}
          </Link>
        ),
        text,
      };
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
      return plain(
        `pushed spec v${String(payload.version)} (${parts})${message}`,
      );
    }
    case "spec_review": {
      const verdict =
        payload.verdict === "approve" ? "approved" : "requested changes on";
      const count = Number(payload.annotation_count ?? 0);
      const suffix =
        count > 0 ? ` with ${count} comment${count === 1 ? "" : "s"}` : "";
      return plain(`${verdict} spec v${String(payload.version)}${suffix}`);
    }
    case "spec_comments_resolved": {
      const ids = payload.comment_ids as unknown[] | undefined;
      const count = ids?.length ?? 0;
      return plain(`resolved ${count} spec comment${count === 1 ? "" : "s"}`);
    }
    case "deleted":
      return plain("moved this to the trash");
    case "restored":
      return plain("restored this from the trash");
    case "moved_in": {
      const slug = payload.from_project;
      const number = payload.from_number;
      const extras = [
        payload.status_from !== payload.status_to &&
        typeof payload.status_to === "string"
          ? `${String(payload.status_from)} → ${payload.status_to}`
          : null,
        Array.isArray(payload.dropped_labels) &&
        payload.dropped_labels.length > 0
          ? `dropped labels: ${payload.dropped_labels.join(", ")}`
          : null,
      ].filter((part): part is string => part !== null);
      const suffix = extras.length > 0 ? ` (${extras.join("; ")})` : "";
      // Blanked source = a project this reader has no role in. Naming it
      // "another project" is the whole of what they are entitled to know.
      if (typeof slug !== "string" || typeof number !== "number") {
        return plain(`moved this in from another project${suffix}`);
      }
      return {
        node: (
          <>
            {"moved this in from "}
            <IssueLink
              slug={slug}
              number={number}
              crossProject
              fallback={`${slug}#${number}`}
            />
            {suffix}
          </>
        ),
        text: `moved this in from ${slug}#${number}${suffix}`,
      };
    }
    case "moved_out": {
      const slug = payload.to_project;
      const number = payload.to_number;
      if (typeof slug !== "string" || typeof number !== "number") {
        return plain("moved this out to another project");
      }
      return {
        node: (
          <>
            {"moved this out to "}
            <IssueLink
              slug={slug}
              number={number}
              crossProject
              fallback={`${slug}#${number}`}
            />
          </>
        ),
        text: `moved this out to ${slug}#${number}`,
      };
    }
  }
}

export const ICONS: Record<TimelineEvent["event_type"], ReactNode> = {
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
  cross_referenced: <LinkIcon className="size-3.5" />,
  attachment_added: <PaperclipIcon className="size-3.5" />,
  question_answered: <ListChecksIcon className="size-3.5 text-green-600" />,
  spec_pushed: <BookOpenTextIcon className="size-3.5" />,
  spec_review: <FileCheck2Icon className="size-3.5 text-amber-600" />,
  spec_comments_resolved: <CheckIcon className="size-3.5 text-green-600" />,
  deleted: <Trash2Icon className="size-3.5 text-destructive" />,
  restored: <ArchiveRestoreIcon className="size-3.5" />,
  moved_out: <LogOutIcon className="size-3.5" />,
  moved_in: <LogInIcon className="size-3.5" />,
};

/**
 * Replace #N tokens with issue links; the rest stays literal text.
 * `commentId` deep-links every ref to that comment's anchor — only
 * `referenced` events provide it, and they contain exactly one ref.
 */
function linkifyIssueRefs(
  text: string,
  slug: string,
  config: RefConfig,
  commentId?: number,
): ReactNode[] {
  return splitIssueRefs(text, config).map((segment, i) =>
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
    ) : segment.type === "text" ? (
      segment.value
    ) : (
      // Action strings are UI-spelled and carry no autolink tokens, but
      // the tokenizer type still includes them.
      segment.text
    ),
  );
}

export function EventRow({
  event,
  slug,
  issueNumber,
  hideActor = false,
}: {
  event: TimelineEvent;
  /** Enables #N → issue link rendering; omit where there is no project. */
  slug?: string;
  issueNumber?: number;
  /** Inside an expanded merge group (T-92) the header already names the
      actor once — sub-rows drop the chip and badge. */
  hideActor?: boolean;
}) {
  const ctx = useEventRenderContext(slug, issueNumber);
  const { node, text } = renderEvent(event, ctx);
  // Below sm the row is plain inline flow — the whole event wraps like a
  // sentence (GitHub mobile), because truncate + title tooltip is unreadable
  // without hover. From sm up it keeps the T-25 single-line grid. The {" "}
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
      {!hideActor && (
        <>
          <UserChip
            user={event.actor}
            nameClassName="font-medium text-foreground/80"
          />{" "}
          <AgentContextBadge
            context={event.agent_context}
            className="align-middle"
          />{" "}
        </>
      )}
      {/* The padding/negative-margin pair buys vertical room inside the
          clipping box — a UserChip's bot badge is positioned outside its
          line box, and truncate's overflow:hidden would shear it off —
          while leaving the row exactly as tall as before. */}
      <span
        className="min-w-0 flex-1 sm:-my-1 sm:truncate sm:py-1"
        title={text}
      >
        {node}
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
