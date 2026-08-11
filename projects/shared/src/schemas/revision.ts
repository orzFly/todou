import { z } from "zod";
import { AgentContext } from "./agent-context.ts";
import { Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

/**
 * One content-changing edit of an issue body or comment. The server pairs
 * both sides of the edit so clients can render a diff without reassembling
 * snapshot chains.
 */
export const Revision = z.object({
  id: Id,
  /** Who performed this edit. */
  actor: UserRef,
  /** When the edit happened. */
  created_at: Timestamp,
  body_before: z.string(),
  body_after: z.string(),
  agent_context: AgentContext.nullable(),
});
export type Revision = z.infer<typeof Revision>;

/** Newest-first; truncation by `limit` only drops older edits whole. */
export const RevisionPage = z.object({ items: z.array(Revision) });
export type RevisionPage = z.infer<typeof RevisionPage>;

export const RevisionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RevisionQuery = z.infer<typeof RevisionQuery>;
