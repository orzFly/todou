import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";

/**
 * One detectable agent harness. `matches` must stay a pure environment
 * predicate — token auto-selection consults it on every command, before any
 * client exists. `context` is called only when `matches` returned true and
 * may probe the filesystem; probe failures degrade to "less metadata",
 * never to an error.
 */
export type Harness = {
  /** AgentContext.agent value, and the auto-selected token profile name. */
  id: string;
  matches(env: Env): boolean;
  context(env: Env, home: string): AgentContext;
};
