/**
 * Per-harness display metadata, keyed by AgentContext.agent. `resume`
 * builds the copy-on-click shell command for a session badge; a harness
 * without one (hermes routes sessions by chat, unknown agents by
 * definition) falls back to copying the session id itself.
 */
export const HARNESS_META: Record<
  string,
  { resume?: (sessionId: string) => string }
> = {
  "claude-code": { resume: (sessionId) => `claude --resume ${sessionId}` },
};
