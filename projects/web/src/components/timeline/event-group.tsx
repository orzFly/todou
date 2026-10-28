import { Link } from "@tanstack/react-router";
import type { Label, TimelineEvent } from "@todou/shared";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareTextIcon,
  UserMinusIcon,
  UserPlusIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { AttachmentEventLink } from "@/components/issue/attachment-list.tsx";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  blockEnd,
  blockVerb,
  type EventRenderContext,
  EventRow,
  IN_SENTENCE,
  iconForEvent,
  referenceSource,
  resolvedAnnotations,
  useEventRenderContext,
} from "@/components/timeline/event-row.tsx";
import {
  type CollapsedFamily,
  type GroupFold,
  isBlockFamily,
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
import { commentAnchor, eventAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils";

type ListRow = {
  key: string | number;
  /** The `#event-N` target, on the one row that stands for that event. */
  id?: string;
  /** The row's own timestamp, which survives as its tooltip. */
  title?: string;
  node: ReactNode;
};

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

/** Names follow the sentence baseline; badge-like status and label chips stay centered. */
const AssigneeRow = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex flex-wrap items-baseline gap-1 align-baseline">
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
                <AssigneeRow>
                  <UserFace face={from} />
                  {"→"}
                  <UserFace face={to} />
                </AssigneeRow>
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
            <AssigneeRow>
              {list.map((face, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two payloads may name the same ghost
                <UserFace key={i} face={face} />
              ))}
            </AssigneeRow>
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
  folded,
  undoneBy,
  onToggleFold,
}: {
  family: MergeFamily;
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
  /** Parsed `#event-N` target currently in the URL hash, if any. */
  anchorEventId?: number;
  /** What this group's block events took off the timeline (T-598). */
  folded?: GroupFold;
  /** A round trip's removes, by the add each one undid (T-613). */
  undoneBy?: Map<number, TimelineEvent>;
  onToggleFold?: () => void;
}) {
  if (rendersAsList(family)) {
    if (isBlockFamily(family)) {
      return (
        <BlockGroup
          events={events}
          slug={slug}
          issueNumber={issueNumber}
          folded={folded}
          undoneBy={family === "block_round_trip" ? undoneBy : undefined}
          toggle={
            folded && <FoldToggle folded={folded} onToggle={onToggleFold} />
          }
        />
      );
    }
    if (family === "attachments") {
      return (
        <AttachmentsGroup
          events={events}
          slug={slug}
          issueNumber={issueNumber}
        />
      );
    }
    if (family === "spec_resolved") {
      return (
        <SpecResolvedGroup
          events={events}
          slug={slug}
          issueNumber={issueNumber}
          anchorEventId={anchorEventId}
        />
      );
    }
    return (
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
 * Every family that renders as a list shares this one component rather than
 * a copied skeleton, which is what keeps "one per line" from growing several
 * slightly different faces.
 */
function ListGroup({
  events,
  slug,
  issueNumber,
  headline,
  rows,
  toggle,
  dim,
}: {
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
  /** The header's sentence, in the family's own words. */
  headline: ReactNode;
  /** Faded as a noop status chain is: the group changed nothing. */
  dim?: boolean;
  /** A control left of the timestamp, where a collapsed group keeps its own. */
  toggle?: ReactNode;
  /**
   * Built by the caller rather than mapped from `events`: a resolve call
   * settles several annotations, and each of those is a row.
   */
  rows: ListRow[];
}) {
  const returnState = useReturnLinkState();
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return null;
  const faded = dim ? "text-muted-foreground/60" : undefined;

  return (
    <div data-testid="event-group">
      <div className="py-1.5 pl-1 text-sm text-muted-foreground sm:flex sm:items-baseline sm:gap-2">
        <span
          className={cn(
            "inline-flex shrink-0 align-middle text-muted-foreground/70 sm:self-center",
            faded,
          )}
        >
          {iconForEvent(first.event_type)}
        </span>{" "}
        <UserChip
          user={first.actor}
          nameClassName="font-medium text-foreground/80"
        />{" "}
        <AgentContextBadge
          context={first.agent_context}
          className="align-middle sm:self-center"
        />{" "}
        <span className={cn("min-w-0 flex-1", faded)}>{headline}</span>{" "}
        {toggle && <>{toggle} </>}
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug, number: String(issueNumber) }}
          hash={eventAnchor(first.id)}
          hashScrollIntoView={false}
          state={returnState}
          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground/70 hover:underline"
          title={
            first === last
              ? first.created_at
              : `${first.created_at} – ${last.created_at}`
          }
        >
          <time dateTime={first.created_at}>
            {new Date(first.created_at).toLocaleString()}
          </time>
        </Link>
      </div>
      <ul className={cn("ml-7 text-sm text-muted-foreground", faded)}>
        {rows.map((row) => (
          <li
            key={row.key}
            id={row.id}
            title={row.title}
            className="py-1 wrap-anywhere"
          >
            {row.node}
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
      rows={events.map((event) => ({
        key: event.id,
        id: eventAnchor(event.id),
        title: event.created_at,
        node: referenceSource(event, ctx).node,
      }))}
    />
  );
}

/**
 * One block verb in the header, the cards it was done to underneath, titles
 * wrapping in full (T-598). A lone event takes this shape too, for the same
 * reason a lone reference does.
 *
 * While collapsed, a card whose reference came from a comment keeps a link
 * to that comment on its row: the reference row that carried it is off the
 * page, and the comment may be the only place that says why the block was
 * added. Expanded, the reference row is back and carries it itself.
 *
 * Given `undoneBy`, the events are adds that were removed again with
 * nothing else to fold them under (T-613): one dimmed group, each row
 * carrying its remove's `#event-N` and both moments in its tooltip.
 */
function BlockGroup({
  events,
  slug,
  issueNumber,
  folded,
  undoneBy,
  toggle,
}: {
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
  folded?: GroupFold;
  undoneBy?: Map<number, TimelineEvent>;
  toggle?: ReactNode;
}) {
  const ctx = useEventRenderContext(slug, issueNumber);
  const first = events[0];
  if (!first) return null;
  return (
    <ListGroup
      events={events}
      slug={slug}
      issueNumber={issueNumber}
      headline={
        undoneBy
          ? first.payload.role === "blocked"
            ? "added and removed the block by"
            : "added and removed this card's block on"
          : blockVerb(first)
      }
      dim={undoneBy !== undefined}
      toggle={toggle}
      rows={events.map((event) => {
        const { payload } = event;
        const cleared =
          event.event_type === "block_cleared" ||
          event.event_type === "block_reblocked";
        const other = cleared
          ? blockEnd(payload.blocker_project_id, payload.blocker_number, ctx)
          : blockEnd(payload.other_project_id, payload.other_number, ctx);
        const references = folded?.expanded
          ? []
          : (folded?.hosts.get(event.id)?.references ?? []);
        const remove = undoneBy?.get(event.id);
        if (remove) {
          return {
            key: event.id,
            id: eventAnchor(event.id),
            title: `added ${event.created_at} · removed ${remove.created_at}`,
            node: <span id={eventAnchor(remove.id)}>{other.node}</span>,
          };
        }
        return {
          key: event.id,
          id: eventAnchor(event.id),
          title: event.created_at,
          node: (
            <>
              {other.node}
              {references.map((reference) => (
                <CommentLink
                  key={reference.id}
                  reference={reference}
                  ctx={ctx}
                />
              ))}
            </>
          ),
        };
      })}
    />
  );
}

/** The comment a folded reference was written in, or nothing where the
    reference came from a card body or its project cannot be named. */
function CommentLink({
  reference,
  ctx,
}: {
  reference: TimelineEvent;
  ctx: EventRenderContext;
}) {
  const { by_comment, by_issue, by_project_id } = reference.payload;
  if (typeof by_comment !== "number" || typeof by_issue !== "number") {
    return null;
  }
  // The fold only takes a reference that names its project by id or names
  // none, so a missing id here means this project.
  const slug =
    typeof by_project_id === "number"
      ? ctx.slugOfProject?.(by_project_id)
      : ctx.slug;
  if (slug === undefined) return null;
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(by_issue) }}
      hash={commentAnchor(by_comment)}
      state={ctx.returnState}
      className="ml-1.5 inline-flex items-center gap-0.5 text-xs whitespace-nowrap text-muted-foreground/70 hover:underline"
      data-testid="fold-comment-link"
    >
      <MessageSquareTextIcon className="size-3" />
      comment
    </Link>
  );
}

/** Counted per reason, since "+3" alone would not say what reopening
    brings back. */
function FoldToggle({
  folded,
  onToggle,
}: {
  folded: GroupFold;
  onToggle?: () => void;
}) {
  const references = folded.references.length;
  const undone = folded.undone.length;
  const label = [
    references > 0
      ? `+${references} reference${references === 1 ? "" : "s"}`
      : null,
    undone > 0 ? `+${undone} undone` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      aria-expanded={folded.expanded}
      onClick={onToggle}
      className="inline-flex shrink-0 items-center gap-0.5 text-xs whitespace-nowrap text-muted-foreground/70 hover:text-foreground hover:underline sm:self-center"
      data-testid="fold-toggle"
    >
      {label}
      {folded.expanded ? (
        <ChevronDownIcon className="size-3" />
      ) : (
        <ChevronRightIcon className="size-3" />
      )}
    </button>
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
      rows={events.map((event) => {
        const file = event.payload.attachment as
          | { id?: number; filename?: string }
          | undefined;
        const filename = file?.filename ?? "a file";
        return {
          key: event.id,
          id: eventAnchor(event.id),
          title: event.created_at,
          node:
            file?.id === undefined ? (
              filename
            ) : (
              <AttachmentEventLink
                slug={slug}
                issueNumber={issueNumber}
                attachmentId={file.id}
                filename={filename}
              />
            ),
        };
      })}
    />
  );
}

/**
 * A review round's resolutions, one row per annotation (T-406). A resolve
 * call settles up to a hundred at once, so rows are per annotation and not
 * per event: a row reading "3 annotations" inside a list whose whole purpose
 * is naming them would be the defect this shape exists to fix.
 *
 * Hidden annotations are drawn apart, behind a closed chevron. Where one
 * pointed is the spec document's own text and stays readable; the reviewer's
 * words are what the hide took away, and opening this block does not give
 * them back.
 */
function SpecResolvedGroup({
  events,
  slug,
  issueNumber,
  anchorEventId,
}: {
  events: TimelineEvent[];
  slug: string;
  issueNumber: number;
  anchorEventId?: number;
}) {
  const ctx = useEventRenderContext(slug, issueNumber);
  const [open, setOpen] = useState(false);

  const shown: ListRow[] = [];
  const hidden: ListRow[] = [];
  let anchorInside = false;
  let total = 0;
  for (const event of events) {
    // Counted off the payload, not off the rows: a payload too malformed to
    // name its annotations still knows how many there were.
    const ids = event.payload.comment_ids;
    total += Array.isArray(ids) ? ids.length : 0;

    const annotations = resolvedAnnotations(event, ctx);
    // The event's `#event-N` target goes on its first visible row, and on the
    // hidden side only when it has no visible one — a permalink should land
    // on something already on screen wherever that is possible.
    const anchored = annotations.find((a) => !a.hidden) ?? annotations[0];
    if (event.id === anchorEventId && anchored?.hidden === true) {
      anchorInside = true;
    }
    for (const annotation of annotations) {
      (annotation.hidden ? hidden : shown).push({
        key: annotation.id,
        id: annotation === anchored ? eventAnchor(event.id) : undefined,
        title: event.created_at,
        node: annotation.node,
      });
    }
  }

  useEffect(() => {
    if (anchorInside) setOpen(true);
  }, [anchorInside]);

  const rows = [...shown];
  if (hidden.length > 0) {
    rows.push({
      key: "hidden",
      node: (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-0.5 text-muted-foreground/70 hover:text-foreground hover:underline"
          data-testid="spec-hidden-toggle"
        >
          {hidden.length} hidden comment{hidden.length === 1 ? "" : "s"}
          {open ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
        </button>
      ),
    });
    if (open) rows.push(...hidden);
  }

  return (
    <ListGroup
      events={events}
      slug={slug}
      issueNumber={issueNumber}
      headline={
        <>
          resolved {total} spec comment{total === 1 ? "" : "s"}
        </>
      }
      rows={rows}
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
  const returnState = useReturnLinkState();

  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return null;

  const summary = summarize(family, events, entities);
  const dim = summary.dim ? "text-muted-foreground/60" : undefined;

  return (
    <div data-testid="event-group">
      <div className="py-1.5 pl-1 text-sm text-muted-foreground sm:flex sm:items-baseline sm:gap-2">
        <span
          className={cn(
            "inline-flex shrink-0 align-middle text-muted-foreground/70 sm:self-center",
            dim,
          )}
        >
          {summary.icon ?? iconForEvent(first.event_type)}
        </span>{" "}
        <UserChip
          user={first.actor}
          nameClassName="font-medium text-foreground/80"
        />{" "}
        <AgentContextBadge
          context={first.agent_context}
          className="align-middle sm:self-center"
        />{" "}
        {/* The same pair the event row's summary span carries: a UserChip's
            bot badge is drawn outside its line box, and truncate's
            overflow:hidden shears 4px off it unless the clipping box is given
            that room back. The negative margin hands the row its original
            height again. */}
        <span
          className={cn("min-w-0 flex-1 sm:-my-1 sm:truncate sm:py-1", dim)}
          title={summary.text}
        >
          {summary.node}
        </span>{" "}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex shrink-0 items-center gap-0.5 text-xs whitespace-nowrap text-muted-foreground/70 hover:text-foreground hover:underline sm:self-center"
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
          state={returnState}
          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground/70 hover:underline"
          title={`${first.created_at} – ${last.created_at}`}
        >
          <time dateTime={first.created_at}>
            {new Date(first.created_at).toLocaleString()}
          </time>
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
