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
  /**
   * Session logs the process holds open, for harnesses that append to theirs
   * for the life of the session — the difference between knowing which
   * session it is in and guessing from which file was written last.
   *
   * `undefined` means the descriptor table could not be read; an empty array
   * means it could, and the harness is holding no log open. Those are opposite
   * answers, so a consumer must not collapse them: the first is ignorance, the
   * second says there is no live session to name.
   */
  openLogs?: readonly string[];
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
 * What a harness says about the session id it holds *now*, as opposed to the
 * one it exported when this process was spawned (T-289).
 *
 * The two ways of having no id are kept apart because they call for opposite
 * responses: with no id to expect there is nothing to report, while a lookup
 * that got as far as a pid and then failed is a silent fall back to the very
 * snapshot the re-read exists to replace.
 */
export type LiveSession = {
  /** The id this process holds now, when one could be read. */
  id?: string;
  /** A pid resolved but its record did not read: the path tried. */
  unreadable?: string;
};

/**
 * One detectable agent harness, one file per harness in this directory, with
 * its tests under `test/harness/` and its entry in `index.ts`.
 *
 * `matches` must stay a pure environment predicate — token auto-selection
 * consults it on every command, before any client exists. `context` is called
 * only when `matches` returned true and may probe the filesystem; probe
 * failures degrade to "less metadata", never to an error.
 *
 * A harness that needs only part of the context may destructure only that
 * part: `context({ env, home })`.
 */
export type Harness = {
  /** AgentContext.agent value, and the auto-selected token profile name. */
  id: HarnessId;
  matches(env: Env): boolean;
  context(ctx: HarnessContext): AgentContext;
  /**
   * Optional because a harness has to publish something re-readable before
   * there is an answer to read. Claude Code does so itself; omp's comes from
   * the extension todou installs into it, so it is present there only while
   * that extension is. The rest keep filtering on the id they started with,
   * and this member is where an answer lands when somebody measures one.
   */
  liveSessionId?(ctx: HarnessContext): LiveSession;
};
