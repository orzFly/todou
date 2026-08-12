import { z } from "zod";
import { Id } from "./schemas/common.ts";

/** SSE event name used on the project change feed. */
export const SSE_CHANGE_EVENT = "change";

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
