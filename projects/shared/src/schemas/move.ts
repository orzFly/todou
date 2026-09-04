import { z } from "zod";
import { Id } from "./common.ts";
import { Issue } from "./issue.ts";
import { ProjectSlug } from "./project.ts";
import { UserRef } from "./user.ts";

export const MoveIssueInput = z.strictObject({
  to_project: ProjectSlug,
  /** Compute permissions, conflicts and the mapping, then write nothing. */
  dry_run: z.boolean().default(false),
});
export type MoveIssueInput = z.infer<typeof MoveIssueInput>;

/**
 * Where a card lives now. `comment_id` rides along only on the comment
 * routes' redirect, which is what saves the client a second hop when it is
 * translating a `#comment-N` anchor.
 */
export const MovedTo = z.object({
  slug: ProjectSlug,
  number: Id,
  comment_id: Id.optional(),
});
export type MovedTo = z.infer<typeof MovedTo>;

/**
 * What the destination project could not take verbatim. Never silent: a
 * dropped label or assignee is reported here, echoed in the `moved_in`
 * event, and previewed by `dry_run` before anyone commits to the move.
 */
export const MoveMapping = z.object({
  status: z.object({ from: z.string(), to: z.string() }),
  dropped_labels: z.array(z.string()),
  dropped_assignees: z.array(UserRef),
});
export type MoveMapping = z.infer<typeof MoveMapping>;

export const MoveIssueResult = z.object({
  /** `number` is null under `dry_run` when a fresh number would be taken. */
  moved_to: MovedTo.extend({ number: Id.nullable() }),
  /** The card moved back into a project that still holds its tombstone. */
  reinhabited: z.boolean(),
  mapping: MoveMapping,
  /** Null under `dry_run`; otherwise the card as it now stands in `to`. */
  issue: Issue.nullable(),
});
export type MoveIssueResult = z.infer<typeof MoveIssueResult>;

/**
 * The 410 body for a reader who cannot read wherever the card went: it
 * admits the card existed and stops there. `title` is the tombstone's
 * snapshot and is absent outside the issue routes, which have no title to
 * show.
 */
export const GoneBody = z.object({
  moved: z.literal(true),
  title: z.string().optional(),
});
export type GoneBody = z.infer<typeof GoneBody>;
