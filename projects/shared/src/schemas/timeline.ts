import { z } from "zod";
import { AgentContext } from "./agent-context.ts";
import { Cursor, Id, Timestamp } from "./common.ts";
import { CommentComponent, CommentComponentInput } from "./component.ts";
import { ProjectSlug } from "./project.ts";
import { UserRef } from "./user.ts";

export const IssueEventType = z.enum([
  "opened",
  "closed",
  "reopened",
  "status_changed",
  "title_changed",
  "label_added",
  "label_removed",
  "assigned",
  "unassigned",
  "referenced",
  "cross_referenced",
  "attachment_added",
  "question_answered",
  "spec_pushed",
  "spec_review",
  "spec_comments_resolved",
  // Trash (T-145). Payload is empty on purpose: actor and timestamp are the
  // whole record, so the trace a deleted card leaves behind carries no title.
  "deleted",
  "restored",
  // The two halves of one cross-project move (T-231), paired by
  // `payload.move_token`: moved_out is the only trace left on the source
  // tombstone, moved_in travels with the card and is what clients read the
  // card's ownership intervals from.
  "moved_out",
  "moved_in",
]);
export type IssueEventType = z.infer<typeof IssueEventType>;

/**
 * Event payloads stay a loose record on the wire; these three exist for
 * clients to `safeParse` the ones they render, so a missing key is a
 * fallback rather than a crash.
 *
 * Every `*_project*` / `*_number` field goes null when the reader may not
 * read the project it names — the key stays, which is how a client tells a
 * redacted field from an old event that never carried one.
 */
export const MovedInPayload = z.object({
  move_token: z.string(),
  lineage: Id,
  from_project_id: Id.nullable(),
  from_project: ProjectSlug.nullable(),
  from_number: Id.nullable(),
  status_from: z.string().optional(),
  status_to: z.string().optional(),
  dropped_labels: z.array(z.string()).default([]),
  /** Logins, not refs: the event outlives the accounts it names. */
  dropped_assignees: z.array(z.string()).default([]),
});
export type MovedInPayload = z.infer<typeof MovedInPayload>;

export const MovedOutPayload = z.object({
  move_token: z.string(),
  to_project_id: Id.nullable(),
  to_project: ProjectSlug.nullable(),
  to_number: Id.nullable(),
});
export type MovedOutPayload = z.infer<typeof MovedOutPayload>;

/**
 * One `referenced` event: who mentioned this card, named by the referring
 * project's permanent id (T-266).
 *
 * Whether the mention was local or came from another project is not stored
 * any more. It is a display property the renderer derives by comparing
 * `by_project_id` with the project it is drawing, because a stored answer
 * goes stale the moment either card moves.
 *
 * `by_project` and `by_moved` are the pre-T-266 spellings. They are still
 * read so that a deployment renders correctly between the upgrade and the
 * `refs migrate` run; nothing writes them any more.
 */
export const ReferencedPayload = z.object({
  by_project_id: Id.nullable().optional(),
  by_issue: Id.nullable(),
  by_comment: Id.nullable().optional(),
  by_project: ProjectSlug.nullable().optional(),
  by_moved: z.boolean().optional(),
});
export type ReferencedPayload = z.infer<typeof ReferencedPayload>;

export const TimelineComment = z.object({
  type: z.literal("comment"),
  id: Id,
  author: UserRef,
  body: z.string(),
  /**
   * Structured payload rendered after the body; immutable once created.
   * Defaults on parse so clients tolerate servers predating T-19.
   */
  component: CommentComponent.nullable().default(null),
  created_at: Timestamp,
  edited_at: Timestamp.nullable(),
  /** Spec-comment resolution stamp (T-23); null for everything else. */
  resolved_at: Timestamp.nullable().default(null),
  agent_context: AgentContext.nullable(),
});
export type TimelineComment = z.infer<typeof TimelineComment>;

/**
 * What POST …/comments answers with: the comment, plus where to start
 * waiting for a reply to it (T-182). A superset of TimelineComment, so
 * only the creation endpoint carries it — timeline entries and
 * GET/PATCH of one comment stay exactly as they were, and a client that
 * knows nothing of the field reads the response as before.
 */
export const CommentCreateResult = TimelineComment.extend({
  /**
   * The comment's own position, so the entries strictly after it are the
   * replies and verdicts that answer it — this comment itself excluded.
   */
  cursor: Cursor,
});
export type CommentCreateResult = z.infer<typeof CommentCreateResult>;

/**
 * A comment plus the issue carrying it — what a bare `#comment-M` needs
 * before it can be rendered as a deep link (T-150).
 */
export const CommentLocation = z.object({
  issue_number: Id,
  /** Spelled in the project's CURRENT reference format. */
  issue_ref: z.string(),
  comment: TimelineComment,
});
export type CommentLocation = z.infer<typeof CommentLocation>;

export const TimelineEvent = z.object({
  type: z.literal("event"),
  id: Id,
  event_type: IssueEventType,
  actor: UserRef,
  payload: z.record(z.string(), z.unknown()),
  created_at: Timestamp,
  agent_context: AgentContext.nullable(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const TimelineItem = z.discriminatedUnion("type", [
  TimelineComment,
  TimelineEvent,
]);
export type TimelineItem = z.infer<typeof TimelineItem>;

export const TimelinePage = z.object({
  items: z.array(TimelineItem),
  prev_cursor: Cursor.nullable(),
  next_cursor: Cursor.nullable(),
  /**
   * Whether more items exist beyond this page in the direction the query
   * walked (`after`/no cursor = forward, `before`/`last` = backward).
   * "False" means the drain is complete as of this response — new rows may
   * still arrive later. Optional because servers predating T-75 omit it;
   * clients then fall back to empty-page termination. `next_cursor` stays a
   * pure position token either way: present on every non-empty page.
   */
  has_more: z.boolean().optional(),
  /**
   * Total items matching the same types/exclude filters, independent of
   * the cursor window — lets clients size the folded middle (T-30).
   */
  total_count: z.number().int().nonnegative(),
});
export type TimelinePage = z.infer<typeof TimelinePage>;

/** What a timeline `types` filter may select: comments or any event type. */
export const TimelineFilterType = z.enum([
  "comment",
  ...IssueEventType.options,
]);
export type TimelineFilterType = z.infer<typeof TimelineFilterType>;

/**
 * Drop entries whose `agent_context.session_id` is this one (T-121). A whole
 * fleet of agents commonly shares one machine account, so `exclude_actor`
 * alone answers "not my account" where a watcher meant "not me" and hides
 * every sibling's writes.
 *
 * The two are orthogonal on their own; together they read as "not mine":
 * an entry carrying *any* session is judged on the session alone, and
 * `exclude_actor` decides only the entries that carry none (web writes,
 * clients without a harness). So a sibling agent on the same account stays
 * visible while one's own writes stay filtered.
 *
 * `agent_context` is self-reported (see agent-context.ts), which makes this
 * a convenience filter, never a permission boundary — enough for "do not
 * wake me with my own writes".
 */
const excludeAgentSession = z.string().min(1).max(200).optional();

export const TimelineQuery = z.object({
  before: Cursor.optional(),
  after: Cursor.optional(),
  last: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().default(false),
  ),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Comma-separated TimelineFilterType list; element validation happens
  // server-side so the error can name the offending entry.
  types: z.string().optional(),
  // Drop entries authored by this user id — lets a watching agent ignore
  // its own writes and (with T-35) powers "unread by others" semantics.
  exclude_actor: z.coerce.number().int().positive().optional(),
  exclude_agent_session: excludeAgentSession,
});
export type TimelineQuery = z.infer<typeof TimelineQuery>;

/** Timeline entries annotated with their issue, for project-wide polling. */
export const ActivityItem = z.discriminatedUnion("type", [
  TimelineComment.extend({ issue_number: Id }),
  TimelineEvent.extend({ issue_number: Id }),
]);
export type ActivityItem = z.infer<typeof ActivityItem>;

export const ActivityPage = z.object({
  items: z.array(ActivityItem),
  next_cursor: Cursor.nullable(),
  /** Same contract as TimelinePage.has_more (forward and `last` only). */
  has_more: z.boolean().optional(),
});
export type ActivityPage = z.infer<typeof ActivityPage>;

/** Forward-only: `after` polls onward, `last` bootstraps a "now" cursor. */
export const ActivityQuery = z.object({
  after: Cursor.optional(),
  last: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().default(false),
  ),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  types: z.string().optional(),
  exclude_actor: z.coerce.number().int().positive().optional(),
  exclude_agent_session: excludeAgentSession,
});
export type ActivityQuery = z.infer<typeof ActivityQuery>;

/** Activity entries tagged with their project, for cross-project polling. */
export const CrossActivityItem = z.discriminatedUnion("type", [
  TimelineComment.extend({ issue_number: Id, project: ProjectSlug }),
  TimelineEvent.extend({ issue_number: Id, project: ProjectSlug }),
]);
export type CrossActivityItem = z.infer<typeof CrossActivityItem>;

/** `next_cursor` is a multi-project envelope (see cursor-envelope.ts). */
export const CrossActivityPage = z.object({
  items: z.array(CrossActivityItem),
  next_cursor: Cursor.nullable(),
  /** Same contract as TimelinePage.has_more (forward and `last` only). */
  has_more: z.boolean().optional(),
});
export type CrossActivityPage = z.infer<typeof CrossActivityPage>;

/**
 * Query for `GET /activity` (T-93). `projects` is the raw comma-separated
 * slug list — split and validated server-side so errors can name the
 * offending slug; absent = every project the caller can read, re-resolved
 * on each request. `after` accepts a multi-project envelope (per-project
 * resume) or a plain cursor (the common starting position everywhere).
 */
export const CrossActivityQuery = z.object({
  projects: z.string().optional(),
  after: Cursor.optional(),
  last: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().default(false),
  ),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  types: z.string().optional(),
  exclude_actor: z.coerce.number().int().positive().optional(),
  exclude_agent_session: excludeAgentSession,
});
export type CrossActivityQuery = z.infer<typeof CrossActivityQuery>;

// Strict on purpose: components are immutable, so the update input simply
// has no `component` key — with a loose schema a PATCH carrying one would
// be silently dropped, which reads as "my edit worked". Unknown keys must
// error and name themselves instead.
export const CommentCreateInput = z.strictObject({
  body: z.string().min(1).max(65536),
  component: CommentComponentInput.optional(),
});
export type CommentCreateInput = z.infer<typeof CommentCreateInput>;

export const CommentUpdateInput = z.strictObject({
  body: z.string().min(1).max(65536),
});
export type CommentUpdateInput = z.infer<typeof CommentUpdateInput>;
