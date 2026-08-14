import type { AgentContext, HarnessId } from "@todou/shared";
import type { Env } from "../config.ts";

/**
 * The ancestor that introduced this harness's markers.
 *
 * Deliberately narrower than the process tree's own record: it carries no
 * environment, so a detector cannot reach into another process's environment
 * and quietly promote it into an existence signal. The process tree arbitrates
 * between harnesses that already matched; it never widens `matches` (T-128).
 */
export type HostProcess = {
  pid: number;
  argv: readonly string[];
  /** Linux only: macOS would need an `lsof` spawn to answer this. */
  cwd?: string;
};

/**
 * What a detector gets to look at. `home` and `cwd` are passed in rather than
 * read from the process so tests can point a probe at a fixture.
 */
export type HarnessContext = {
  env: Env;
  home: string;
  cwd: string;
  /**
   * Lazy, because walking the process tree costs two `ps` spawns on macOS: a
   * harness that never asks never pays. Returns undefined when the tree is
   * unavailable or this harness's markers cannot be attributed to any visible
   * ancestor.
   */
  host(): HostProcess | undefined;
};

/**
 * One detectable agent harness. `matches` must stay a pure environment
 * predicate — token auto-selection consults it on every command, before any
 * client exists. `context` is called only when `matches` returned true and
 * may probe the filesystem; probe failures degrade to "less metadata",
 * never to an error.
 *
 * A harness that needs only part of the context may destructure only that
 * part: `context({ env, home })`.
 */
export type Harness = {
  /** AgentContext.agent value, and the auto-selected token profile name. */
  id: HarnessId;
  matches(env: Env): boolean;
  context(ctx: HarnessContext): AgentContext;
};
