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
  // T-567. Same payload shape as `attachment_added`: the row is gone, so the
  // event is the only place the name survives.
  "attachment_deleted",
  "question_answered",
  "spec_pushed",
  "spec_withdrawn",
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
  // Block edges (T-377). The first two land on both ends of the edge and
  // tell them apart by `payload.role` rather than by four event types — one
  // object appearing twice, the way `referenced` carries its direction. The
  // last two land on the blocked end alone: they are news about whether the
  // work may start, which only that end is waiting for.
  "block_added",
  "block_removed",
  "block_cleared",
  "block_reblocked",
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
  /**
   * Who held the card as it left (T-576): the tombstone keeps neither
   * assignee rows nor assignment events, so a scoped watch reads it here.
   * Absent from events written before.
   */
  assignee_ids: z.array(Id).optional(),
});
export type MovedOutPayload = z.infer<typeof MovedOutPayload>;

/**
 * What a card was opened with (T-605): setting these at creation writes no
 * `status_changed`, `label_added` or `assigned`, so this is the only record
 * of them. Each entry has the shape of the event it stands in for. Events
 * written before carry `{}`, which this schema refuses.
 */
export const OpenedPayload = z.object({
  status: z.object({ id: Id, name: z.string() }),
  labels: z.array(z.object({ id: Id, name: z.string(), color: z.string() })),
  /** Logins, not refs: the event outlives the accounts it names. */
  assignees: z.array(z.object({ id: Id, login: z.string() })),
});
export type OpenedPayload = z.infer<typeof OpenedPayload>;

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
 * read so that a deployment renders correctly whether or not it ever ran the
 * `refs migrate` pass that 0.5.1 was the last release to carry; nothing
 * writes them any more.
 */
export const ReferencedPayload = z.object({
  by_project_id: Id.nullable().optional(),
  by_issue: Id.nullable(),
  by_comment: Id.nullable().optional(),
  by_project: ProjectSlug.nullable().optional(),
  by_moved: z.boolean().optional(),
});
export type ReferencedPayload = z.infer<typeof ReferencedPayload>;

/**
 * `block_added` / `block_removed` (T-377). `role` is what this end of the
 * edge is, so one event type serves both timelines; the `other_*` fields name
 * the end the reader is not on. The slug is resolved at read time, null when
 * redacted, and optional so new clients can still read an older server.
 */
export const BlockEdgePayload = z.object({
  edge_id: Id,
  role: z.enum(["blocked", "blocker"]),
  other_project_id: Id.nullable(),
  other_number: Id.nullable(),
  other_project: ProjectSlug.nullable().optional(),
});
export type BlockEdgePayload = z.infer<typeof BlockEdgePayload>;

/**
 * `block_cleared` / `block_reblocked`, which only ever reach the blocked end.
 * The read-time slug follows the same redaction and compatibility rules.
 */
export const BlockClearedPayload = z.object({
  edge_id: Id,
  blocker_project_id: Id.nullable(),
  blocker_number: Id.nullable(),
  blocker_project: ProjectSlug.nullable().optional(),
});
export type BlockClearedPayload = z.infer<typeof BlockClearedPayload>;

/**
 * What a comment is (T-575). An `action` is an IRC-style `/me` line: its body
 * is the text that follows the author's name. A plain string on the wire so a
 * client meeting a kind it does not know yet can still draw the comment as a
 * comment, which is what every kind degrades to.
 */
export const CommentKind = z.enum(["comment", "action"]);
export type CommentKind = z.infer<typeof CommentKind>;

/** Longest `/me` text, in code points. A status line, not a message. */
export const ACTION_MAX_LENGTH = 500;

/**
 * Why `text` cannot be an action, or null when it can. One rule for the
 * server, the composer and the CLI, so each refuses the same drafts with the
 * same words. Judged on the trimmed text, which is what gets stored.
 */
export function actionTextProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "an action needs some text after /me";
  if (/[\r\n]/.test(trimmed)) return "an action is a single line";
  const length = [...trimmed].length;
  if (length > ACTION_MAX_LENGTH) {
    return `an action is at most ${ACTION_MAX_LENGTH} characters (this one is ${length})`;
  }
  return null;
}

/** `kind` read with the default every server before T-575 implies. */
export function isAction(comment: { kind?: string }): boolean {
  return comment.kind === "action";
}

export const TimelineComment = z.object({
  type: z.literal("comment"),
  id: Id,
  author: UserRef,
  body: z.string(),
  /**
   * `comment` or `action` (T-575). Optional rather than defaulted because
   * responses are cast, not parsed: a server predating T-575 sends no key,
   * and absent has to read as an ordinary comment either way.
   */
  kind: z.string().optional(),
  /**
   * Structured payload rendered after the body; immutable once created.
   * Defaults on parse so clients tolerate servers predating T-19.
   */
  component: CommentComponent.nullable().default(null),
  created_at: Timestamp,
  edited_at: Timestamp.nullable(),
  /** Spec-comment resolution stamp (T-23); null for everything else. */
  resolved_at: Timestamp.nullable().default(null),
  /**
   * Hide stamp (T-281); null while the comment shows its body. Defaulted
   * like `resolved_at` because a server predating T-281 sends no such key,
   * and a client reading it must land on "not hidden" rather than throw.
   */
  hidden_at: Timestamp.nullable().default(null),
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
  // Hand back hidden comments' bodies as stored (T-281). Off by default, and
  // the blanking happens server-side, so "a read that did not ask for them
  // does not carry them" holds for the CLI, `--json` and `todou api` alike.
  include_hidden: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().default(false),
  ),
});
export type TimelineQuery = z.infer<typeof TimelineQuery>;

/**
 * Narrow the stream to entries that concern the caller's account (T-576):
 * a comma-separated list of `assigned` (every entry on a card assigned to
 * the account when the entry happened, plus the assignment events naming
 * it, plus a `moved_out` whose card it held) and `mentioned` (the comment
 * or `opened` entry that @-mentioned it as written). Several values are a
 * union. Validated server-side, like `types`, so the error names the entry.
 *
 * The account, not the agent session: assignees and mentions only ever
 * name accounts, so every session sharing a machine account shares one
 * scope.
 */
const activityScope = z.string().optional();

/** What an activity `scope` may name; see the `scope` query parameter. */
export const ActivityScope = z.enum(["assigned", "mentioned"]);
export type ActivityScope = z.infer<typeof ActivityScope>;

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
  /**
   * The `scope` the server applied, echoed back (T-576). Absent from a
   * server that predates it — which ignored the parameter and delivered
   * the unscoped stream — and absent when no scope was asked for. Plain
   * strings: a client checks membership, so a value it has never heard of
   * cannot fail the parse.
   */
  scope: z.array(z.string()).optional(),
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
  scope: activityScope,
  include_hidden: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().default(false),
  ),
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
  /**
   * The `scope` the server applied, echoed back (T-576). Absent from a
   * server that predates it — which ignored the parameter and delivered
   * the unscoped stream — and absent when no scope was asked for. Plain
   * strings: a client checks membership, so a value it has never heard of
   * cannot fail the parse.
   */
  scope: z.array(z.string()).optional(),
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
  scope: activityScope,
  include_hidden: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().default(false),
  ),
});
export type CrossActivityQuery = z.infer<typeof CrossActivityQuery>;

// Strict on purpose: components are immutable, so the update input simply
// has no `component` key — with a loose schema a PATCH carrying one would
// be silently dropped, which reads as "my edit worked". Unknown keys must
// error and name themselves instead.
export const CommentCreateInput = z
  .strictObject({
    body: z.string().min(1).max(65536),
    component: CommentComponentInput.optional(),
    kind: CommentKind.optional(),
  })
  .superRefine((v, ctx) => refineAction(v, ctx));
export type CommentCreateInput = z.infer<typeof CommentCreateInput>;

/** `actionTextProblem` as a schema refinement, for the two create inputs. */
export function refineAction(
  v: { body: string; kind?: CommentKind; component?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (v.kind !== "action") return;
  if (v.component !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["component"],
      message: "an action carries no component",
    });
  }
  const problem = actionTextProblem(v.body);
  if (problem !== null) {
    ctx.addIssue({ code: "custom", path: ["body"], message: problem });
  }
}

export const CommentUpdateInput = z.strictObject({
  body: z.string().min(1).max(65536),
});
export type CommentUpdateInput = z.infer<typeof CommentUpdateInput>;

/**
 * Hide or unhide a list of comments in one transaction (T-281). The server
 * takes an explicit id list and nothing else: which comments deserve hiding
 * is a policy the caller computes (`selectHidable`), so changing the policy
 * never needs a server release.
 *
 * The 500 cap sizes one transaction, not a card: a selector that picks more
 * splits into several calls.
 */
export const COMMENT_HIDE_MAX_IDS = 500;

/** Comment ids a hide settled, by what it settled about them (T-307). */
export const SettledByHide = z.object({
  declined_questions: z.array(Id),
  resolved_annotations: z.array(Id),
});
export type SettledByHide = z.infer<typeof SettledByHide>;

export const CommentHideInput = z.strictObject({
  hidden: z.boolean(),
  comment_ids: z.array(Id).min(1).max(COMMENT_HIDE_MAX_IDS),
});
export type CommentHideInput = z.infer<typeof CommentHideInput>;

export const CommentHideResult = z.object({
  /** The ids in the target state after this call, in request order. */
  hidden: z.array(Id),
  /**
   * Ids that already were in the target state, so this call did not write
   * them. Named separately because a client computes its selection before it
   * calls: someone else's write may have landed in between, and knowing
   * which ids this call actually moved is what makes a replay free.
   */
  unchanged: z.array(Id),
  /**
   * What hiding settled on its way past (T-307), absent when it settled
   * nothing. Optional rather than always-present because responses are cast
   * and not parsed: a server predating T-307 sends no such key, so every
   * reader has to treat `undefined` and "nothing settled" as one answer —
   * `(result.settled ?? null) !== null`.
   *
   * `unhide` never settles anything, and none of this is reversible: the
   * body comes back, the declined answer and the resolved annotation do not.
   */
  settled: SettledByHide.optional(),
});
export type CommentHideResult = z.infer<typeof CommentHideResult>;
