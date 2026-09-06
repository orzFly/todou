import { z } from "zod";
import { Id } from "./schemas/common.ts";
import { ProjectSlug } from "./schemas/project.ts";

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

/**
 * What the SSE routes emit: a ChangeEvent tagged with the project it came
 * from, so one user-level stream can carry every readable project (T-122).
 * The slug slot matches CrossActivityItem's (T-93).
 */
export const CrossChangeEvent = ChangeEvent.extend({
  project: ProjectSlug,
  /**
   * Computed per receiver (T-273): after this change, is `issue_number` in
   * *your* inbox? Only connections that subscribed with `?inbox=1` get it.
   * Absent means the server did not work it out — not subscribed, no
   * `issue_number`, an entity the inbox does not track, a failed judgement
   * or a flood — and the client must then refetch unconditionally.
   *
   * This keeps ChangeEvent's pointer-only promise: it is not entity data
   * but a boolean derived from what this receiver may already read, and it
   * answers only "should you refetch".
   */
  inbox: z.boolean().optional(),
});
export type CrossChangeEvent = z.infer<typeof CrossChangeEvent>;
