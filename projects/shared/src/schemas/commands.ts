import { z } from "zod";
import { Id } from "./common.ts";
import { Issue } from "./issue.ts";
import {
  COMMENT_HIDE_MAX_IDS,
  SettledByHide,
  TimelineComment,
} from "./timeline.ts";

// Slash commands (T-161): the web composer compiles `/close`-style draft lines
// into these payloads and submits them together with the comment body. The
// semantics are INCREMENTAL — add one label, drop one assignee — which is why
// this is not `PATCH issue`, whose `label_ids` / `assignee_ids` replace the
// whole set and would silently drop concurrent edits by someone else.

export const CommandInput = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status"), status_id: Id }),
  z.strictObject({ type: z.literal("label_add"), label_id: Id }),
  z.strictObject({ type: z.literal("label_remove"), label_id: Id }),
  z.strictObject({ type: z.literal("assign"), user_id: Id }),
  z.strictObject({ type: z.literal("unassign"), user_id: Id }),
  // `/hide-all` (T-307). Not a field change, and here for the reason the
  // rest are: the comment and the hide have to land together, all the more
  // so now that hiding may also decline somebody's question. The ids are
  // resolved by the composer at submit time, from a drain of the timeline
  // — the rendered page is folded and would miss the middle.
  z.strictObject({
    type: z.literal("comments_hide"),
    hidden: z.boolean(),
    comment_ids: z.array(Id).min(1).max(COMMENT_HIDE_MAX_IDS),
  }),
]);
export type CommandInput = z.infer<typeof CommandInput>;

export const COMMAND_SUBMIT_MAX_COMMANDS = 20;

export const CommandSubmitInput = z
  .strictObject({
    /** Body with the command lines already stripped; empty = no comment. */
    body: z.string().max(65536).default(""),
    commands: z.array(CommandInput).max(COMMAND_SUBMIT_MAX_COMMANDS),
  })
  .refine((v) => v.body.trim() !== "" || v.commands.length > 0, {
    error: "body and commands cannot both be empty",
  });
export type CommandSubmitInput = z.infer<typeof CommandSubmitInput>;

export const CommandSubmitResult = z.object({
  /** Null when the submission carried commands only. */
  comment: TimelineComment.nullable(),
  /** The issue after every command was applied. */
  issue: Issue,
  /**
   * Absent unless the submission carried a `comments_hide`. Read it the way
   * `CommentHideResult.settled` is read — `(result.hide ?? null) !== null` —
   * because responses are cast and a server predating T-307 sends no key.
   */
  hide: z
    .object({
      hidden: z.array(Id),
      unchanged: z.array(Id),
      settled: SettledByHide.optional(),
    })
    .optional(),
});
export type CommandSubmitResult = z.infer<typeof CommandSubmitResult>;
