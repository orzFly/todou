import { readFileSync } from "node:fs";
import type { Env } from "../config.ts";
import { detectHarnessId } from "./index.ts";
import { ompHostAncestor, ompStateAttempt } from "./omp.ts";
import type { OmpState } from "./omp-state.ts";
import { piHostAncestor, piState } from "./pi.ts";
import {
  ancestorPids,
  type ProcessTreeIo,
  readAncestors,
} from "./process-tree.ts";

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
  peer?: "claude-code" | "omp" | "pi";
  /**
   * The tool names the extension registered, when it published any.
   * Advice reads them to know the watch tool is available (T-357).
   */
  tools?: readonly string[];
};

/**
 * A live native extension owner. All fields identify the watch's lifetime:
 * changing any of them, or losing the record, invalidates the old watch.
 * Environment-only channels cannot provide this proof and have no owner.
 */
export type NativeWatchOwner = {
  peer: "omp" | "pi";
  pid: number;
  path: string;
  sessionId: string;
  socket: string;
  token: string;
};

function ownedStateAttempt(
  peer: "omp" | "pi",
  env: Env,
  io?: Partial<ProcessTreeIo>,
): { state?: OmpState; unreadable?: string } {
  const ctx = {
    env,
    host: () => {
      const chain = readAncestors(io);
      return peer === "omp" ? ompHostAncestor(chain) : piHostAncestor(chain);
    },
    ancestorPids: () => ancestorPids(io),
  };
  return peer === "omp" ? ompStateAttempt(ctx) : { state: piState(ctx) };
}

/**
 * Read current owned state, including publisher liveness, on every call.
 * Supplying an empty process-tree seam bypasses the command-level ancestry
 * cache: a long-running watch must observe its host disappearing.
 */
export function nativeWatchOwner(
  env: Env,
  io: Partial<ProcessTreeIo> = {},
): NativeWatchOwner | undefined {
  const peer = detectHarnessId(env, io);
  if (peer !== "omp" && peer !== "pi") return undefined;
  const { state } = ownedStateAttempt(peer, env, io);
  if (state?.socket === undefined || state.token === undefined)
    return undefined;
  // Messaging keeps compatibility with explicit paths outside a visible
  // process tree. A lifetime guard requires positive ancestry as well.
  if (!ancestorPids(io).includes(state.pid)) return undefined;
  return {
    peer,
    pid: state.pid,
    path: state.path,
    sessionId: state.sessionId,
    socket: state.socket,
    token: state.token,
  };
}

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
    case "omp":
      return nativeMessaging("omp", env, io);
    case "pi":
      return nativeMessaging("pi", env, io);
    case "claude-code":
    case null:
      return {
        socket: env.CLAUDE_CODE_MESSAGING_SOCKET,
        token: env.CLAUDE_CODE_MESSAGING_TOKEN,
        peer: "claude-code",
      };
    default:
      // codex and hermes publish nothing to push into, and
      // the claude-code socket some of them inherit is not theirs to use.
      return {};
  }
}

function nativeMessaging(
  peer: "omp" | "pi",
  env: Env,
  io?: Partial<ProcessTreeIo>,
): HarnessMessaging {
  const { state, unreadable } = ownedStateAttempt(peer, env, io);
  if (state?.socket !== undefined) {
    return {
      socket: state.socket,
      token: state.token,
      peer,
      ...(state.tools === undefined ? {} : { tools: state.tools }),
    };
  }
  // An identity-only legacy record can still accompany an env channel.
  // Invalid/partial channel fields are not legacy: never revive their
  // stale exported credentials. Recheck the record rather than confusing
  // omitted fields with the channel parser rejecting supplied fields.
  let legacyState = false;
  if (peer === "omp" && state) {
    try {
      const record = JSON.parse(readFileSync(state.path, "utf8"));
      legacyState =
        record?.v === 1 &&
        record.pid === state.pid &&
        record.session_id === state.sessionId &&
        record.socket === undefined &&
        record.token === undefined;
    } catch {
      return {};
    }
  }
  // Legacy env-only channels require no conflicting manifest claim or
  // evidence that an outer host supplied the inherited channel.
  if (
    peer === "omp" &&
    !unreadable &&
    env.TODOU_MESSAGING_SOCKET &&
    (legacyState || (!state && !env.TODOU_OMP_STATE && !env.TODOU_PI_STATE))
  ) {
    const host = ompHostAncestor(readAncestors(io));
    if (
      !host?.env.TODOU_MESSAGING_SOCKET &&
      (legacyState ||
        (host?.env.OMPCODE !== "1" && host?.env.PI_CODING_AGENT !== "true"))
    ) {
      return {
        socket: env.TODOU_MESSAGING_SOCKET,
        token: env.TODOU_MESSAGING_TOKEN,
        peer,
        ...toolsFromEnv(env),
      };
    }
  }
  return {};
}
