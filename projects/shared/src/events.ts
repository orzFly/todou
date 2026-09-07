import { z } from "zod";
import { Id, Timestamp } from "./schemas/common.ts";
import { ProjectSlug } from "./schemas/project.ts";

/** SSE event name used on the project change feed. */
export const SSE_CHANGE_EVENT = "change";

/**
 * SSE event name for events addressed to one user rather than a project.
 * Read positions and preferences are written without any change event
 * (services/reads.ts and the prefs route explain why), yet both decide what
 * the inbox contains, so the account's other tabs and devices need this
 * signal (T-275).
 */
export const SSE_ME_EVENT = "me";

/**
 * SSE heartbeat event name. A real event rather than an SSE comment because
 * the browser EventSource API cannot observe comments, and clients rely on
 * heartbeat arrival to detect silently dead connections (a proxy can hold a
 * stream open long after the upstream died).
 */
export const SSE_PING_EVENT = "ping";

export const ChangeEntity = z.enum([
  "project",
  "member",
  "status",
  "label",
  "issue",
  "comment",
  "timeline",
  "attachment",
  "spec",
]);
export type ChangeEntity = z.infer<typeof ChangeEntity>;

export const ChangeAction = z.enum(["created", "updated", "deleted"]);
export type ChangeAction = z.infer<typeof ChangeAction>;

/**
 * Pointer-only change notification: carries no entity data so the feed can
 * never leak fields the subscriber is not allowed to read — clients refetch
 * through the authorized REST API instead.
 */
export const ChangeEvent = z.object({
  entity: ChangeEntity,
  id: Id,
  action: ChangeAction,
  issue_number: Id.optional(),
});
export type ChangeEvent = z.infer<typeof ChangeEvent>;

/**
 * The deciding fields of one receiver's inbox row for one issue, as the
 * server computed them after a change (T-275). Field names match InboxItem
 * exactly, which is what lets a client compare this against the row it
 * already has cached, field by field.
 *
 * `open_questions` is the raw column value, the same one InboxItem carries —
 * not the value inboxKeepCheck zeroes out for a closed issue. A closed issue
 * can still hold unanswered questions, and a fingerprint built from the
 * zeroed value would never match the cache.
 *
 * `last_activity_at` is left out on purpose: every change that lands on an
 * issue moves it, so including it would make the fingerprint differ on every
 * event, which is what the T-273 boolean already did.
 */
export const InboxRowState = z.object({
  updated_at: Timestamp,
  unread: z.boolean(),
  unread_comments: z.number().int().nonnegative(),
  pending_spec_review: z.boolean(),
  open_questions: z.number().int().nonnegative(),
});
export type InboxRowState = z.infer<typeof InboxRowState>;

/**
 * What the SSE routes emit: a ChangeEvent tagged with the project it came
 * from, so one user-level stream can carry every readable project (T-122).
 * The slug slot matches CrossActivityItem's (T-93).
 */
export const CrossChangeEvent = ChangeEvent.extend({
  project: ProjectSlug,
  /**
   * Computed per receiver (T-275, replacing the T-273 `inbox` boolean):
   * after this change, which row does `issue_number` occupy in *your*
   * inbox? Only connections that subscribed with `?inbox=1` get it.
   *
   *   key absent — the server did not work it out: not subscribed, no
   *                `issue_number`, an entity the inbox does not track, a
   *                failed judgement, or a flood. The client must then
   *                refetch unconditionally.
   *   null       — worked out: the issue is not in your inbox.
   *   object     — worked out: it is, and these are that row's deciding
   *                fields.
   *
   * "Did not work it out" and "not in your inbox" have to stay tellable
   * apart, so the server omits the key in the first case and never sends
   * null for it. A client that cannot tell them apart has to refetch
   * unconditionally either way, which is the whole point of the field.
   *
   * This keeps ChangeEvent's pointer-only promise: it is not entity data
   * but a value derived from what this receiver may already read, and it
   * answers only "should you refetch".
   */
  inbox_row: InboxRowState.nullable().optional(),
});
export type CrossChangeEvent = z.infer<typeof CrossChangeEvent>;

/**
 * Where the writer says it is writing from (T-275). An opaque string the
 * server truncates and echoes into `MeEvent.origin` without parsing or
 * logging it; a client that recognizes its own value drops the event,
 * because it has already invalidated locally. Read only by the writes that
 * emit a MeEvent, ignored everywhere else.
 */
export const ORIGIN_HEADER = "x-todou-origin";

export const ORIGIN_MAX_LENGTH = 64;

const Origin = z.string().max(ORIGIN_MAX_LENGTH).optional();

/**
 * Something about the receiver's own account changed. Only connections that
 * subscribed with `?inbox=1` and are registered under this user id get it.
 *
 * The single-issue branch carries `inbox_row`: MarkReadOnView re-sends its
 * PUT roughly every two seconds on a busy issue, so a plain broad
 * invalidation would make the other tabs refetch /me/inbox at that same
 * cadence (p50 206ms). With the fingerprint the client runs the same
 * comparison it runs for change events, and reading an issue usually takes
 * it out of the inbox, which the other tabs never had cached.
 */
export const MeEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issue_read"),
    project: ProjectSlug,
    issue_number: Id,
    inbox_row: InboxRowState.nullable(),
    origin: Origin,
  }),
  z.object({
    kind: z.literal("reads_swept"),
    /** Present for a sweep scoped to projects; absent for a full sweep. */
    projects: z.array(ProjectSlug).optional(),
    origin: Origin,
  }),
  z.object({ kind: z.literal("prefs"), origin: Origin }),
]);
export type MeEvent = z.infer<typeof MeEvent>;
