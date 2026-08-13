import { z } from "zod";
import { Cursor, Id, Timestamp } from "./common.ts";
import { Label, Status, StatusCategory } from "./project.ts";
import { UserRef } from "./user.ts";

export const Issue = z.object({
  id: Id,
  number: Id,
  title: z.string(),
  body: z.string(),
  status: Status,
  author: UserRef,
  assignees: z.array(UserRef),
  labels: z.array(Label),
  created_at: Timestamp,
  updated_at: Timestamp,
  /** Last body-changing edit; null when the body was never edited. */
  body_edited_at: Timestamp.nullable(),
  /**
   * Unanswered questions across all question comments (#19, feeds #46).
   * Defaults on parse so clients tolerate servers predating #19.
   */
  open_questions: z.number().int().nonnegative().default(0),
  /**
   * Denormalized spec state (#23): current version, verdict of the current
   * version's review, unresolved anchored comments. Null version/status =
   * no spec. Defaults keep old servers parseable.
   */
  spec_version: z.number().int().positive().nullable().default(null),
  spec_review_status: z
    .enum(["unreviewed", "approved", "changes_requested"])
    .nullable()
    .default(null),
  spec_unresolved_comments: z.number().int().nonnegative().default(0),
  /**
   * Per-viewer: whether this issue has activity by someone other than the
   * requesting user, newer than their last-seen position (#46). Computed
   * only for list responses; every other path returns the default false.
   * Defaults on parse so clients tolerate older servers.
   */
  unread: z.boolean().default(false),
  /**
   * Per-viewer: comments (any component kind) by someone other than the
   * requesting user, newer than their last-seen position (#77; same
   * threshold as `unread`). Events don't count. Exact value — display
   * capping is the client's business. Computed only for list responses;
   * every other path returns the default 0. Defaults on parse so clients
   * tolerate older servers.
   */
  unread_comments: z.number().int().nonnegative().default(0),
});
export type Issue = z.infer<typeof Issue>;

/** List rows exclude the (potentially huge) markdown body. */
export const IssueListItem = Issue.omit({ body: true });
export type IssueListItem = z.infer<typeof IssueListItem>;

export const IssueListPage = z.object({
  items: z.array(IssueListItem),
  next_cursor: z.string().nullable(),
});
export type IssueListPage = z.infer<typeof IssueListPage>;

export const IssueCreateInput = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(65536).default(""),
  status_id: Id.optional(),
  assignee_ids: z.array(Id).default([]),
  label_ids: z.array(Id).default([]),
});
export type IssueCreateInput = z.infer<typeof IssueCreateInput>;

export const IssueUpdateInput = z.object({
  title: z.string().min(1).max(300).optional(),
  body: z.string().max(65536).optional(),
  status_id: Id.optional(),
  assignee_ids: z.array(Id).optional(),
  label_ids: z.array(Id).optional(),
});
export type IssueUpdateInput = z.infer<typeof IssueUpdateInput>;

/** Body of PUT /issues/{n}/read — advance the caller's last-seen position. */
export const IssueReadInput = z.strictObject({
  /** Position to advance to (never regresses); omitted = server now(). */
  up_to: Timestamp.optional(),
});
export type IssueReadInput = z.infer<typeof IssueReadInput>;

const csvIds = z
  .string()
  .transform((s) => s.split(",").map((p) => Number(p)))
  .pipe(z.array(Id));

/** Query-string filters for the issue list (all values arrive as strings). */
export const IssueListQuery = z.object({
  /** Exact issue numbers — lets clients batch-resolve #N references. */
  numbers: csvIds.optional(),
  status: csvIds.optional(),
  label: csvIds.optional(),
  assignee: z.coerce.number().int().positive().optional(),
  category: StatusCategory.optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["created", "updated", "number"]).default("created"),
  order: z.enum(["asc", "desc"]).default("desc"),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type IssueListQuery = z.infer<typeof IssueListQuery>;

/** Category-neutral subset of the list filters, for the counts endpoint. */
export const IssueCountsQuery = IssueListQuery.pick({
  status: true,
  label: true,
  assignee: true,
  q: true,
});
export type IssueCountsQuery = z.infer<typeof IssueCountsQuery>;

/** Open/closed totals under the same filters, for the list header tabs. */
export const IssueCounts = z.object({
  open: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});
export type IssueCounts = z.infer<typeof IssueCounts>;
