import type { AgentContext, HarnessId } from "@todou/shared";
import type { Env } from "../config.ts";

/**
 * One detectable agent harness. `matches` must stay a pure environment
 * predicate — token auto-selection consults it on every command, before any
 * client exists. `context` is called only when `matches` returned true and
 * may probe the filesystem; probe failures degrade to "less metadata",
 * never to an error.
 *
 * `home` and `cwd` are passed in rather than read from the process so tests
 * can point a probe at a fixture; a harness that needs neither may declare
 * fewer parameters.
 */
export type Harness = {
  /** AgentContext.agent value, and the auto-selected token profile name. */
  id: HarnessId;
  matches(env: Env): boolean;
  context(env: Env, home: string, cwd: string): AgentContext;
};
