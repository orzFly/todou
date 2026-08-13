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
  "attachment_added",
  "question_answered",
  "spec_pushed",
  "spec_review",
  "spec_comments_resolved",
]);
export type IssueEventType = z.infer<typeof IssueEventType>;

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
   * Total items matching the same types/exclude_actor filters, independent
   * of the cursor window — lets clients size the folded middle (T-30).
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
