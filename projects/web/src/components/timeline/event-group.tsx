import { Link } from "@tanstack/react-router";
import type { Label, TimelineEvent } from "@todou/shared";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  UserMinusIcon,
  UserPlusIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { AttachmentEventLink } from "@/components/issue/attachment-list.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  EventRow,
  ICONS,
  IN_SENTENCE,
  referenceSource,
  useEventRenderContext,
} from "@/components/timeline/event-row.tsx";
import {
  type CollapsedFamily,
  type MergeFamily,
  netAssignees,
  netStatusChain,
  rendersAsList,
} from "@/components/timeline/group-events.ts";
import {
  type EventEntities,
  type ResolvedUser,
  resolveLabel,
  resolveStatus,
  resolveUser,
  useEventEntities,
} from "@/components/timeline/use-event-entities.ts";
import { eventAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils";

/** Collapsed summary: the rich node for the row plus a plain-text mirror
    for the truncation tooltip (the EventRow pattern). `icon` is for the
    families whose sentence and whose first event can disagree. */
type Summary = {
  node: ReactNode;
  text: string;
  dim?: boolean;
  icon?: ReactNode;
};

/** Chips carry their own gaps only inside a flex box; the summary row is
    inline text flow, so the list needs one of its own. */
const ChipRow = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex flex-wrap items-center gap-1 align-middle">
    {children}
  </span>
);

/** A label toggled twice in one run would otherwise repeat, keys and all. */
const distinct = (labels: Label[]): Label[] => [
  ...new Map(labels.map((l) => [l.id, l])).values(),
];

/** An assignee as a chip, or as the bare `@login` resolveUser degrades to
    for someone the project no longer knows. */
const UserFace = ({ face }: { face: ResolvedUser }) =>
  face.user ? (
    <UserChip user={face.user} nameClassName={IN_SENTENCE} />
  ) : (
    <span className={IN_SENTENCE}>{face.text}</span>
  );

function summarize(
  family: CollapsedFamily,
  events: TimelineEvent[],
  entities: EventEntities,
): Summary {
  switch (family) {
    case "status": {
      const chain = netStatusChain(events);
      // A noop chain has no net transition worth printing — show the full
      // path instead, dimmed, so the reader can skip it at a glance (T-92).
      const path = chain.isNoop
        ? [chain.net.from, ...chain.hops.map((h) => h.to)]
        : [chain.net.from, chain.net.to];
      const faces = path.map((end) => resolveStatus(end, entities.statusById));
      return {
        node: (
          <>
            {"moved "}
            <ChipRow>
              {faces.map((face, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a chain may revisit a status
                <Fragment key={i}>
                  {i > 0 && "→"}
                  <StatusPill status={face} />
                </Fragment>
              ))}
            </ChipRow>
          </>
        ),
        text: `moved ${faces.map((f) => f.name).join(" → ")}`,
        dim: chain.isNoop,
      };
    }
    case "labels": {
      const labels = (type: TimelineEvent["event_type"]) =>
        distinct(
          events
            .filter((e) => e.event_type === type)
            .map((e) => resolveLabel(e.payload.label, entities.labelById)),
        );
      const added = labels("label_added");
      const removed = labels("label_removed");
      const phrase = (verb: string, list: Label[]) =>
        `${verb} label${list.length === 1 ? "" : "s"} `;
      const names = (list: Label[]) => list.map((l) => l.name).join(", ");
      return {
        node: (
          <>
            {added.length > 0 && (
              <>
                {phrase("added", added)}
                <ChipRow>
                  <LabelChips labels={added} />
                </ChipRow>
              </>
            )}
            {added.length > 0 && removed.length > 0 && " · "}
            {removed.length > 0 && (
              <>
                {phrase("removed", removed)}
                <ChipRow>
                  <LabelChips labels={removed} />
                </ChipRow>
              </>
            )}
          </>
        ),
        text: [
          added.length > 0 ? phrase("added", added) + names(added) : null,
          removed.length > 0
            ? phrase("removed", removed) + names(removed)
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
    case "assignees": {
      const chain = netAssignees(events);
      // A run that cancels out has no net assignment to print, so it prints
      // the whole gesture dimmed, as a noop status chain does.
      const shown = chain.isNoop ? chain.touched : chain.net;
      const faces = (users: unknown[]) =>
        users.map((user) => resolveUser(user, entities.memberById));
      const added = faces(shown.added);
      const removed = faces(shown.removed);
      const [to] = added;
      const [from] = removed;
      if (!chain.isNoop && added.length === 1 && removed.length === 1) {
        if (to && from) {
          return {
            node: (
              <>
                {"reassigned "}
                <ChipRow>
                  <UserFace face={from} />
                  {"→"}
                  <UserFace face={to} />
                </ChipRow>
              </>
            ),
            text: `reassigned ${from.text} → ${to.text}`,
            icon: <UserPlusIcon className="size-3.5" />,
          };
        }
      }
      const half = (verb: string, list: ResolvedUser[]) =>
        list.length === 0 ? null : (
          <>
            {`${verb} `}
            <ChipRow>
              {list.map((face, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two payloads may name the same ghost
                <UserFace key={i} face={face} />
              ))}
            </ChipRow>
          </>
        );
      const names = (list: ResolvedUser[]) =>
        list.map((face) => face.text).join(", ");
      const netIcon =
        added.length > 0 ? (
          <UserPlusIcon className="size-3.5" />
        ) : (
          <UserMinusIcon className="size-3.5" />
        );
      return {
        node: (
          <>
            {half("assigned", added)}
            {added.length > 0 && removed.length > 0 && " · "}
            {half("unassigned", removed)}
          </>
        ),
        text: [
          added.length > 0 ? `assigned ${names(added)}` : null,
          removed.length > 0 ? `unassigned ${names(removed)}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        dim: chain.isNoop,
        icon: chain.isNoop ? undefined : netIcon,
      };
    }
  }
}

/**
 * One render unit for a merged run (T-92). Status, label and assignment runs
 * collapse to a summary row with an expander; the list families keep every
 * event visible as a block list (T-99, T-369) — nothing to expand.
 */
export function EventGroup({
  family,
  events,
  slug,
  issueNumber,
  anchorEventId,
}: {
  family: MergeFamily;
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
  /** Parsed `#event-N` target currently in the URL hash, if any. */
  anchorEventId?: number;
}) {
  if (rendersAsList(family)) {
    return family === "attachments" ? (
      <AttachmentsGroup events={events} slug={slug} issueNumber={issueNumber} />
    ) : (
      <ReferencedGroup events={events} slug={slug} issueNumber={issueNumber} />
    );
  }
  return (
    <CollapsedGroup
      family={family}
      events={events}
      slug={slug}
      issueNumber={issueNumber}
      anchorEventId={anchorEventId}
    />
  );
}

/**
 * GitHub's "This was referenced" shape (T-99): a header naming the actor
 * once, then one always-visible line per event — long content wraps instead
 * of truncating. A lone event renders this exact way too (groupTimeline
 * emits singles of these families as groups), so there is no second
 * rendering path. The `#event-N` anchors sit on the list rows themselves,
 * so deep links land without any expansion; each row's created_at survives
 * only as its tooltip.
 *
 * Both families that render as a list share this one component rather than
 * a copied skeleton, which is what keeps "one per line" from growing two
 * slightly different faces.
 */
function ListGroup({
  events,
  slug,
  issueNumber,
  headline,
  renderRow,
}: {
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
  /** The header's sentence, in the family's own words. */
  headline: ReactNode;
  renderRow: (event: TimelineEvent) => ReactNode;
}) {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return null;

  return (
    <div data-testid="event-group">
      <div className="py-1.5 pl-1 text-sm text-muted-foreground sm:flex sm:items-center sm:gap-2">
        <span className="inline-flex shrink-0 align-middle text-muted-foreground/70">
          {ICONS[first.event_type]}
        </span>{" "}
        <UserChip
          user={first.actor}
          nameClassName="font-medium text-foreground/80"
        />{" "}
        <AgentContextBadge
          context={first.agent_context}
          className="align-middle"
        />{" "}
        <span className="min-w-0 flex-1">{headline}</span>{" "}
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issueNumber) }}
          hash={eventAnchor(first.id)}
          hashScrollIntoView={false}
          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground/70 hover:underline"
          title={
            first === last
              ? first.created_at
              : `${first.created_at} – ${last.created_at}`
          }
        >
          {new Date(first.created_at).toLocaleString()}
        </Link>
      </div>
      <ul className="ml-7 text-sm text-muted-foreground">
        {events.map((event) => (
          <li
            key={event.id}
            id={eventAnchor(event.id)}
            title={event.created_at}
            className="py-1 wrap-anywhere"
          >
            {renderRow(event)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReferencedGroup({
  events,
  slug,
  issueNumber,
}: {
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
}) {
  const ctx = useEventRenderContext(slug, issueNumber);
  return (
    <ListGroup
      events={events}
      slug={slug}
      issueNumber={issueNumber}
      headline={
        <>
          referenced {events.length} time{events.length === 1 ? "" : "s"}
        </>
      }
      renderRow={(event) => referenceSource(event, ctx).node}
    />
  );
}

/**
 * `attached …` as one row per file (T-369). A lone upload takes this shape
 * too: the alternative is a second face for the family that has to be
 * maintained — and to go wrong — separately.
 *
 * No per-row timestamp, as with references: the files of one upload are
 * seconds apart, so the header's own stamp is the whole story and the exact
 * moment stays on each row's tooltip.
 */
function AttachmentsGroup({
  events,
  slug,
  issueNumber,
}: {
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
}) {
  return (
    <ListGroup
      events={events}
      slug={slug}
      issueNumber={issueNumber}
      headline={
        <>
          attached {events.length} file{events.length === 1 ? "" : "s"}
        </>
      }
      renderRow={(event) => {
        const file = event.payload.attachment as
          | { id?: number; filename?: string }
          | undefined;
        const filename = file?.filename ?? "a file";
        return file?.id === undefined ? (
          filename
        ) : (
          <AttachmentEventLink
            slug={slug}
            issueNumber={issueNumber}
            attachmentId={file.id}
            filename={filename}
          />
        );
      }}
    />
  );
}

/**
 * The collapsing families (T-92): shared actor header, a family-specific
 * summary, and an expander that restores the raw rows. The group has no
 * anchor of its own — per-event `#event-N` targets live on the sub-rows,
 * so a permalink into the group must force it open.
 */
function CollapsedGroup({
  family,
  events,
  slug,
  issueNumber,
  anchorEventId,
}: {
  family: CollapsedFamily;
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
  anchorEventId?: number;
}) {
  const [open, setOpen] = useState(false);
  const anchorInside =
    anchorEventId !== undefined &&
    events.some((event) => event.id === anchorEventId);
  // Reacts to in-page permalink clicks too, not just the initial mount.
  // A later manual collapse sticks because the effect only re-fires when
  // the hash target (or the group's membership) changes.
  useEffect(() => {
    if (anchorInside) setOpen(true);
  }, [anchorInside]);

  const entities = useEventEntities(slug);

  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return null;

  const summary = summarize(family, events, entities);
  const dim = summary.dim ? "text-muted-foreground/60" : undefined;

  return (
    <div data-testid="event-group">
      <div className="py-1.5 pl-1 text-sm text-muted-foreground sm:flex sm:items-center sm:gap-2">
        <span
          className={cn(
            "inline-flex shrink-0 align-middle text-muted-foreground/70",
            dim,
          )}
        >
          {summary.icon ?? ICONS[first.event_type]}
        </span>{" "}
        <UserChip
          user={first.actor}
          nameClassName="font-medium text-foreground/80"
        />{" "}
        <AgentContextBadge
          context={first.agent_context}
          className="align-middle"
        />{" "}
        <span
          className={cn("min-w-0 flex-1 sm:truncate", dim)}
          title={summary.text}
        >
          {summary.node}
        </span>{" "}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex shrink-0 items-center gap-0.5 text-xs whitespace-nowrap text-muted-foreground/70 hover:text-foreground hover:underline"
          data-testid="event-group-toggle"
        >
          {events.length} items
          {open ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
        </button>{" "}
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issueNumber) }}
          hash={eventAnchor(first.id)}
          hashScrollIntoView={false}
          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground/70 hover:underline"
          title={`${first.created_at} – ${last.created_at}`}
        >
          {new Date(first.created_at).toLocaleString()}
        </Link>
      </div>
      {open && (
        <div className="ml-7 border-l-2 pl-2">
          {events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              slug={slug}
              issueNumber={issueNumber}
              hideActor
            />
          ))}
        </div>
      )}
    </div>
  );
}
