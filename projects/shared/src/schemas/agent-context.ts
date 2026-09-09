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

/**
 * The `agent` value every detectable harness reports. Two registries are
 * keyed by this union — a detector in `projects/cli/src/harness/` and a
 * logo in `projects/web/src/lib/harness.ts` — so an id added here fails to
 * compile until both sides exist. Other clients may report anything;
 * `AgentContext.agent` stays a free-form string on the wire.
 *
 * So adding a harness starts here, and the two builds then name what is
 * still missing: a detector (`Harness` in `cli/src/harness/types.ts`), a
 * label beside the registry it joins, and a mark (`HARNESS_META`, whose
 * `logo` is required). A resume command, a token profile on the host and an
 * integration page under `docs/` are each optional on top.
 */
export const HARNESS_IDS = [
  "claude-code",
  "codex",
  "hermes-agent",
  "omp",
  "pi",
] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const AGENT_CONTEXT_HEADER = "x-todou-agent-context";

/** Anything beyond this is rejected rather than truncated. */
export const AGENT_CONTEXT_MAX_BYTES = 2048;
