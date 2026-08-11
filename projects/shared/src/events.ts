import { z } from "zod";
import { Id } from "./schemas/common.ts";

/** SSE event name used on the project change feed. */
export const SSE_CHANGE_EVENT = "change";

export const ChangeEntity = z.enum([
  "project",
  "member",
  "status",
  "label",
  "issue",
  "comment",
  "timeline",
  "attachment",
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
