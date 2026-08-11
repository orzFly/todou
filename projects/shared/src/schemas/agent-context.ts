import { z } from "zod";

/**
 * Self-reported provenance of an automated client (e.g. Claude Code).
 * Authorship is still decided by authentication; this only records which
 * agent/session/model produced a write, for display and auditing.
 */
export const AgentContext = z.object({
  agent: z.string().min(1).max(100),
  session_id: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
});
export type AgentContext = z.infer<typeof AgentContext>;

export const AGENT_CONTEXT_HEADER = "x-todou-agent-context";

/** Anything beyond this is rejected rather than truncated. */
export const AGENT_CONTEXT_MAX_BYTES = 2048;
