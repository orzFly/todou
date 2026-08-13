import { z } from "zod";
import { Timestamp } from "./common.ts";
import { IssueListItem } from "./issue.ts";
import { ProjectSlug } from "./project.ts";

const csvSlugs = z
  .string()
  .transform((s) => [...new Set(s.split(","))])
  .pipe(z.array(ProjectSlug));

/** Query of GET /me/inbox. `limit` is per project, not global. */
export const InboxQuery = z.object({
  /** Comma-separated slugs; omitted = every project the caller can read. */
  projects: csvSlugs.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type InboxQuery = z.infer<typeof InboxQuery>;

/**
 * One inbox row (T-97): an issue that currently needs the caller's
 * attention — unread foreign activity, a spec version awaiting their
 * review, or open questions. Reuses the issue-list fields so row
 * rendering and the mark-read flow work unchanged across projects.
 */
export const InboxItem = IssueListItem.extend({
  project: z.object({ slug: ProjectSlug, name: z.string() }),
  /**
   * Newest activity among the row's qualifying reasons; the response is
   * sorted by this, descending. Grouping is the client's business.
   */
  last_activity_at: Timestamp,
  /**
   * A spec version is waiting for THIS caller: current version is
   * unreviewed and was pushed by someone else. Not derivable client-side
   * from spec_review_status — the pusher exclusion needs the server.
   */
  pending_spec_review: z.boolean(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const InboxPage = z.object({
  items: z.array(InboxItem),
  /** True when any project hit the per-project limit. */
  truncated: z.boolean(),
});
export type InboxPage = z.infer<typeof InboxPage>;

/**
 * Body of PUT /me/read (contract owned by T-97's design, implementation
 * by T-100): bulk-advance read positions. Per project, in that project's
 * database, both layers move — every issue_reads row AND the frontier;
 * advancing only the frontier is not enough because per-issue rows take
 * priority (coalesce semantics in reads.ts).
 */
export const BulkReadInput = z.strictObject({
  /** Scope; omitted = every project the caller can read. */
  projects: z.array(ProjectSlug).optional(),
  /** Position to advance to; omitted = each project database's now(). */
  up_to: Timestamp.optional(),
});
export type BulkReadInput = z.infer<typeof BulkReadInput>;
