import type { AgentContext, HarnessId } from "@todou/shared";
import type { Env } from "../config.ts";

/**
 * The ancestor that introduced this harness's markers, or — when the harness
 * was identified by a record one of them published — the ancestor that wrote
 * it.
 *
 * Deliberately narrower than the process tree's own record: it carries no
 * environment, so a detector cannot reach into another process's environment
 * and quietly promote it into an existence signal (T-128). That rule is
 * unchanged. What the process tree may now do beyond arbitrating is described
 * on `Harness.matches`, and it is not this: reading a *file a harness wrote
 * about itself* is the harness speaking, while reading its environment is us
 * guessing from something it never meant to say.
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
  /**
   * Our ancestors' pids, nearest first — enough to ask which of them published
   * a `<pid>.json` record about itself, and nothing more. Pids only, so this
   * grants no reach into another process's environment (see `HostProcess`).
   *
   * Lazy and cached for the same reason as `host`, and cheaper than it: the
   * caller that needs this runs before anything is known to match.
   */
  ancestorPids(): readonly number[];
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
 * only when the harness was selected and may probe the filesystem; probe
 * failures degrade to "less metadata", never to an error.
 *
 * Selection has two stages, and `matches` is the whole of the first. When it
 * puts up at least one candidate the second stage does not run, so it can
 * never take a harness away from one that matched on the environment — which
 * is what keeps the claude-code tie-break, and every other ordering rule in
 * `HARNESSES`, exactly as it was. Only when nothing matches does selection ask
 * whether an ancestor published a record naming itself; that is the one way a
 * harness can be found without a marker in our environment, and it is there
 * because omp's eval runtimes are spawned without its markers while still
 * being the same session (T-313). The cost of that second stage is a failed
 * `readdir` on a machine that never installed the extension.
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
