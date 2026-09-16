import type { Env } from "../config.ts";
import { detectHarnessId } from "./index.ts";
import { publishedState } from "./omp-state.ts";
import { ancestorPids, type ProcessTreeIo } from "./process-tree.ts";

/**
 * Where a push transport delivers, and what it authenticates with — the pair
 * `--follow=uds` needs, read once per command.
 *
 * Absent means this environment has no push channel, which every caller
 * already had a path for: `followTransport` refuses `--follow=uds` up front
 * and `followAdvice` offers stdout or polling instead.
 */
export type HarnessMessaging = {
  socket?: string;
  token?: string;
  /** Which side is receiving, deciding whether a push wraps an envelope. */
  peer?: "claude-code" | "omp";
  /**
   * The tool names the omp extension registered, when it published any.
   * Advice reads them to know the watch tool is available (T-357).
   */
  tools?: readonly string[];
};

/**
 * `TODOU_OMP_TOOLS` as the bash tool's environment carries it: one
 * comma-separated line, cheaper for `claim()` to export than a record write
 * and split here. Empty entries drop out; an empty result is no tools at
 * all, which is what an older extension publishes by omitting the variable.
 */
function toolsFromEnv(env: { TODOU_OMP_TOOLS?: string }): {
  tools?: readonly string[];
} {
  const names = (env.TODOU_OMP_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return names.length === 0 ? {} : { tools: names };
}

/**
 * The messaging endpoint of the harness this command is running under.
 *
 * One reader for what used to be seven copies of the same two environment
 * lookups, spread across three commands. A second harness with a channel of
 * its own is a branch here; missing one of the seven would have been a
 * tracker where some commands can push and others cannot, with nothing to
 * say which is which.
 *
 * Which harness is asked matters, because a session's variables outlive the
 * session: every agent started from a Claude Code tool inherits that
 * session's socket, and a push sent there reaches an agent that never asked
 * while the one that ran the watch waits for a batch that already went
 * somewhere else. So an endpoint counts only for the harness that published
 * it, and a detected harness with no channel of its own has none — which
 * `followTransport` refuses up front and `followAdvice` explains.
 *
 * No harness detected is the exception, and deliberately so: a supervisor or
 * a wrapper script started by a session runs todou without carrying the
 * session's markers, and the socket in its environment is the session that
 * really is waiting on it.
 */
export function harnessMessaging(
  env: Env,
  io?: Partial<ProcessTreeIo>,
): HarnessMessaging {
  // omp sets `CLAUDECODE=1` alongside its own marker on purpose, so both
  // predicates match every omp shell and the process tree is what tells the
  // nested cases apart. The seam is threaded from the command for the same
  // reason the other probes take one: an answer that depends on the real
  // /proc is one a test cannot state.
  switch (detectHarnessId(env, io)) {
    case "omp": {
      // Exported by the extension `todou integration install omp` writes —
      // into omp's own bash tool, and nowhere else. Preferred where it is
      // there, because reading it costs nothing.
      if (env.TODOU_MESSAGING_SOCKET) {
        return {
          socket: env.TODOU_MESSAGING_SOCKET,
          token: env.TODOU_MESSAGING_TOKEN,
          peer: "omp",
          ...toolsFromEnv(env),
        };
      }
      // Every other context omp spawns — the `!` shell, both eval runtimes —
      // gets a curated environment with none of the pair in it, so without
      // this an omp with the extension running and its socket listening
      // reports no push channel at all, and says so in prose that blames the
      // extension for not being installed.
      //
      // Asked by ancestor pid, exactly as the session id is (T-312), and just
      // as lazily: a machine that never installed the extension pays one
      // failed `readdir` and never walks the tree. The record's pair is
      // believed or dropped whole, so a socket here always has its token.
      const state = publishedState(env, () => ancestorPids(io));
      return state?.socket === undefined
        ? {}
        : {
            socket: state.socket,
            token: state.token,
            peer: "omp",
            ...(state.tools === undefined ? {} : { tools: state.tools }),
          };
    }
    case "claude-code":
    case null:
      return {
        socket: env.CLAUDE_CODE_MESSAGING_SOCKET,
        token: env.CLAUDE_CODE_MESSAGING_TOKEN,
        peer: "claude-code",
      };
    default:
      // codex, pi, hermes: none of them publishes anything to push into, and
      // the claude-code socket some of them inherit is not theirs to use.
      return {};
  }
}
