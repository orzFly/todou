import type { HarnessId } from "@todou/shared";
import { HARNESS_LABELS } from "./harness/index.ts";

/** Which of the six answers this environment gets. */
export type FollowSituation =
  | "uds"
  | "uds-opted-out"
  | "claude-code-no-peer"
  | "omp-not-installed"
  | "known-harness"
  | "no-harness";

export type FollowAdvice = {
  situation: FollowSituation;
  harness: HarnessId | null;
  /** The report, one paragraph per element, blank-line separated on stdout. */
  paragraphs: string[];
};

/**
 * The half that names a transport and the half that falls back to polling,
 * with the clause that opens each of them as the parameter. Two situations
 * ask the reader the same question in different words — whether it can keep
 * reading a running command's output — and everything after that question is
 * the same advice, so it is written once and cannot drift apart.
 */
function streamOrPoll(lead: string, fallback: string): string[] {
  return [
    `${lead} \`--follow=stdout\` with \`todou watch\` or \`todou issue watch\`, and if you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.`,
    `${fallback} Either watch, run without \`--follow\`, blocks, returns one batch and exits; re-open it from the cursor it printed. \`--poll\` checks once without blocking.`,
  ];
}

/** Claude Code, with no push channel to use. */
const MONITOR = streamOrPoll(
  "If you have a Monitor tool — anything that keeps reading a running command's output and wakes you on it — use",
  "Without one you cannot use follow at all: use poll mode.",
);

/** Any other harness, and no harness: todou cannot answer for it. */
const UNKNOWN_HARNESS = streamOrPoll(
  "If you can watch a stream continuously and be woken by what it writes, try",
  "If you cannot, use poll mode.",
);

const CLOSING =
  "Whichever mode you use, the watch carries spec and question activity too: a review verdict and a question answer each arrive on it as their own line, so you do not need a separate `spec wait` or `question wait` running beside it.";

/**
 * The answer when the push channel is there, said once for both harnesses
 * that have one. Only the name differs, and two copies of this paragraph
 * would eventually differ in more than the name.
 */
function udsParagraphs(label: string): string[] {
  return [
    `running under ${label}, and \`--follow=uds\` is available.`,
    "Use it with `todou watch` or `todou issue watch`, started as a background task (run in background = true). If you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.",
    CLOSING,
  ];
}

/**
 * Which follow mode this environment supports, and the words that say so.
 *
 * Its three inputs are everything that decides the branch, so a caller states
 * a situation rather than assembling an environment. Nothing here reaches the
 * network, the config or git: the command exists to answer while the tracker
 * is down.
 *
 * The uds condition is exactly `followTransport`'s — the socket variable is
 * set, and nothing further is probed. Stat-ing the path would catch a session
 * that has since exited, but it would also let this command say "unavailable"
 * where `--follow=uds` says "available", and two answers to one question is
 * what this command exists to remove. A stale path surfaces as
 * `push unreachable` on the watch, which is a failure the agent can read.
 */
export function followAdvice(input: {
  harness: HarnessId | null;
  socket: string | undefined;
  optedOut: boolean;
}): FollowAdvice {
  const { harness, socket, optedOut } = input;
  const advice = (situation: FollowSituation, paragraphs: string[]) => ({
    situation,
    harness,
    paragraphs,
  });

  if (harness === "claude-code") {
    if (!socket) {
      return advice("claude-code-no-peer", [
        "running under Claude Code, but CLAUDE_CODE_MESSAGING_SOCKET is not set in this process, so `--follow=uds` has no session to push to.",
        ...MONITOR,
        CLOSING,
      ]);
    }
    // Its own situation rather than a fold into claude-code-no-peer: the peer
    // is there, and a report blaming a missing socket would send the reader
    // looking at the wrong thing. It says nothing about how to undo the
    // opt-out — that is the user's standing decision, and an agent that reads
    // the way back out of it is one turn away from taking it.
    if (optedOut) {
      return advice("uds-opted-out", [
        "running under Claude Code, but `--follow=uds` is opted out on this machine.",
        ...MONITOR,
        CLOSING,
      ]);
    }
    return advice("uds", udsParagraphs("Claude Code"));
  }

  if (harness === "omp") {
    // The one situation with a way out that is an agent's own to take: the
    // extension is per-user and installing it changes nothing about anyone
    // else's session, unlike `opt-out-uds`, which is the user's standing
    // decision about this machine. So this one names its command.
    if (!socket) {
      return advice("omp-not-installed", [
        "running under omp, but the todou extension is not installed in it, so there is no session socket to push to.",
        "Run `todou integration install omp` and restart omp — the extension also lets todou read which session omp is in, instead of inferring it from session-log timestamps.",
        ...UNKNOWN_HARNESS,
        CLOSING,
      ]);
    }
    if (optedOut) {
      return advice("uds-opted-out", [
        "running under omp, but `--follow=uds` is opted out on this machine.",
        ...UNKNOWN_HARNESS,
        CLOSING,
      ]);
    }
    return advice("uds", udsParagraphs("omp"));
  }

  if (harness !== null) {
    return advice("known-harness", [
      `running under ${HARNESS_LABELS[harness]}, but whether it can monitor a background command's stdout is not something todou knows.`,
      ...UNKNOWN_HARNESS,
      CLOSING,
    ]);
  }

  return advice("no-harness", [
    "no agent harness detected, so what this environment does with a long-running command is not something todou knows.",
    ...UNKNOWN_HARNESS,
    CLOSING,
  ]);
}
