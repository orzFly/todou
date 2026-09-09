import type { Env } from "../config.ts";
import { detectHarnessId } from "./index.ts";
import type { ProcessTreeIo } from "./process-tree.ts";

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
};

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
    case "omp":
      // Exported by the extension `todou integration install omp` writes, and
      // absent in an omp without it — which is a real answer, not a gap:
      // there is no session there to push to, and `follow-advice.ts` names
      // the command that changes it.
      return {
        socket: env.TODOU_MESSAGING_SOCKET,
        token: env.TODOU_MESSAGING_TOKEN,
      };
    case "claude-code":
    case null:
      return {
        socket: env.CLAUDE_CODE_MESSAGING_SOCKET,
        token: env.CLAUDE_CODE_MESSAGING_TOKEN,
      };
    default:
      // codex, pi, hermes: none of them publishes anything to push into, and
      // the claude-code socket some of them inherit is not theirs to use.
      return {};
  }
}
