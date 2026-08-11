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

const csvIds = z
  .string()
  .transform((s) => s.split(",").map((p) => Number(p)))
  .pipe(z.array(Id));

/** Query-string filters for the issue list (all values arrive as strings). */
export const IssueListQuery = z.object({
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
