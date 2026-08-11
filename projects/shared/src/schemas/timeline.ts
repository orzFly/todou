import { z } from "zod";
import { Cursor, Id, Timestamp } from "./common.ts";
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
]);
export type IssueEventType = z.infer<typeof IssueEventType>;

export const TimelineComment = z.object({
  type: z.literal("comment"),
  id: Id,
  author: UserRef,
  body: z.string(),
  created_at: Timestamp,
  edited_at: Timestamp.nullable(),
});
export type TimelineComment = z.infer<typeof TimelineComment>;

export const TimelineEvent = z.object({
  type: z.literal("event"),
  id: Id,
  event_type: IssueEventType,
  actor: UserRef,
  payload: z.record(z.string(), z.unknown()),
  created_at: Timestamp,
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
});
export type TimelinePage = z.infer<typeof TimelinePage>;

export const TimelineQuery = z.object({
  before: Cursor.optional(),
  after: Cursor.optional(),
  last: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().default(false),
  ),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TimelineQuery = z.infer<typeof TimelineQuery>;

export const CommentCreateInput = z.object({
  body: z.string().min(1).max(65536),
});
export type CommentCreateInput = z.infer<typeof CommentCreateInput>;

export const CommentUpdateInput = z.object({
  body: z.string().min(1).max(65536),
});
export type CommentUpdateInput = z.infer<typeof CommentUpdateInput>;
