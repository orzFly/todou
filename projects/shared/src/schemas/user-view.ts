import { z } from "zod";
import { Cursor, Timestamp } from "./common.ts";
import { IssueListItem } from "./issue.ts";
import { MemberRole, ProjectBrief } from "./project.ts";

/**
 * What the user page shows about somebody other than the reader (T-374):
 * the cards they are involved in and the projects they hold a seat in.
 *
 * Both lists are cut to what the **reader** may see, never to what the
 * subject may — otherwise the page would report which projects the subject
 * works in that the reader has no access to.
 */

/** A row of `GET /users/{ref}/issues`; the project names where it lives. */
export const UserIssueItem = IssueListItem.extend({
  project: ProjectBrief,
});
export type UserIssueItem = z.infer<typeof UserIssueItem>;

/** How the subject is involved with the card. */
export const UserIssueRole = z.enum(["any", "author", "assignee"]);
export type UserIssueRole = z.infer<typeof UserIssueRole>;

export const UserIssueState = z.enum(["open", "closed", "all"]);
export type UserIssueState = z.infer<typeof UserIssueState>;

export const UserIssuesQuery = z.object({
  role: UserIssueRole.default("any"),
  state: UserIssueState.default("open"),
  /** The envelope this endpoint minted; absent starts at the newest card. */
  after: Cursor.optional(),
  /** Delivered rows, across every project — not per project as on the inbox. */
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type UserIssuesQuery = z.infer<typeof UserIssuesQuery>;

export const UserIssuesPage = z.object({
  items: z.array(UserIssueItem),
  next_cursor: z.string().nullable(),
  /**
   * Whether this page was cut. Separate from `next_cursor` for the reason
   * `/activity` keeps them apart: the cursor says where to resume, and only
   * this says whether resuming would deliver anything.
   */
  has_more: z.boolean(),
});
export type UserIssuesPage = z.infer<typeof UserIssuesPage>;

export const UserMembership = z.object({
  project: ProjectBrief,
  role: MemberRole,
  /** When the subject joined the project. */
  created_at: Timestamp,
});
export type UserMembership = z.infer<typeof UserMembership>;

export const UserProjects = z.object({
  items: z.array(UserMembership),
});
export type UserProjects = z.infer<typeof UserProjects>;
