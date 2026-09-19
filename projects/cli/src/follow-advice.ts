import type { HarnessId } from "@todou/shared";
import { HARNESS_LABELS } from "./harness/index.ts";

/**
 * The watch tool the omp extension registers. Spelled again inside
 * `integrations/omp/extension.ts` (`TOOL_NAME`), which cannot import from
 * here; a test pins the two spellings together.
 */
export const OMP_WATCH_TOOL = "todou_watch";

/** The answer this environment gets. */
export type FollowSituation =
  | "uds"
  | "uds-opted-out"
  | "omp-tool"
  | "pi-tool"
  | "pi-no-tool"
  | "claude-code-no-peer"
  | "omp-no-peer"
  | "known-harness"
  | "no-harness";

export type FollowAdvice = {
  situation: FollowSituation;
  harness: HarnessId | null;
  /** The report, one paragraph per element, blank-line separated on stdout. */
  paragraphs: string[];
};

/**
 * How a harness starts a command that has to outlive the turn.
 *
 * The one clause in this file an agent acts on verbatim, so it is the
 * harness's own spelling or nothing: Claude Code's Bash tool takes `run in
 * background`, omp's takes `async`, and an agent handed the other one's name
 * goes looking for a parameter that does not exist — then falls back on a
 * trailing `&` or a `nohup`, which is precisely what omp steers it away from.
 *
 * omp's names `async` and not `hub`, though both belong to one job system: a
 * `--follow=uds` watch has to end with the session it pushes into, and a hub
 * process is managed per project — it outlives the session and goes on pushing
 * at a socket nobody holds. hub earns its mention as where that job is read,
 * not as the way to start it.
 *
 * omp's entry carries two parameters where Claude Code's carries one, because
 * `async` on its own does not outlive omp's own deadline: measured at 300
 * seconds by default, and it ends the command with no signal it can catch, so
 * the job that dies cannot even report where it stopped.
 *
 * Only the two harnesses todou has measured have an entry. For the rest the
 * sentences below simply make no claim, because a guess here would be read as
 * an instruction.
 */
const BACKGROUNDED: Record<"claude-code" | "omp", string> = {
  "claude-code": "started as a background task (run in background = true)",
  omp: "started with the bash tool's `async: true` and `timeout: 0` (`hub` is where you see how that job is doing)",
};

/**
 * The half that names a transport and the half that falls back to polling,
 * with the clause that opens each of them as the parameter. Two situations
 * ask the reader the same question in different words — whether it can keep
 * reading a running command's output — and everything after that question is
 * the same advice, so it is written once and cannot drift apart.
 */
function streamOrPoll(
  lead: string,
  fallback: string,
  backgrounded = "",
): string[] {
  return [
    `${lead} \`--follow=stdout\` with \`todou watch\` or \`todou issue watch\`${backgrounded ? `, ${backgrounded}` : ""}, and if you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.`,
    `${fallback} Either watch, run without \`--follow\`, blocks, returns one batch and exits; re-open it from the cursor it printed. \`--poll\` checks once without blocking.`,
  ];
}

/** Claude Code, with no push channel to use. */
const MONITOR = streamOrPoll(
  "If you have a Monitor tool — anything that keeps reading a running command's output and wakes you on it — use",
  "Without one you cannot use follow at all: use poll mode.",
);

/* Named rather than repeated: omp gets this question in the same words as
   every unmeasured harness, and only the answer about backgrounding differs. */
const UNKNOWN_LEAD =
  "If you can watch a stream continuously and be woken by what it writes, try";
const UNKNOWN_FALLBACK = "If you cannot, use poll mode.";

/** Any other harness, and no harness: todou cannot answer for it. */
const UNKNOWN_HARNESS = streamOrPoll(UNKNOWN_LEAD, UNKNOWN_FALLBACK);

/**
 * Its own paragraph rather than more of the clause above, because the deadline
 * is the bash tool's and not the watch's: an agent that reads it as advice about
 * watching leaves every other long wait to be killed at five minutes.
 */
const OMP_DEADLINE =
  "`timeout: 0` is what keeps that job alive: the bash tool's deadline defaults to 300 seconds and ends the command with no signal it can catch, so a watch that reaches it stops without printing the cursor a restart would resume from, and whatever arrived in between is never read. Every todou command that has to outlive a single tool call takes the same parameter — `spec push --wait`, `spec wait`, `question wait`, and any watch run with `--forever`.";

/**
 * The tool carries the wait, so these two say what the tool's own prose
 * does not: that spec and question answers ride on it, and what to do on
 * the occasions something is still run alone. Not `CLOSING`, whose
 * "whichever mode you use" describes a choice this situation no longer
 * offers.
 */
const TOOL_CARRIES =
  "The watch carries spec and question activity too: a review verdict and a question answer each arrive on it as their own line, so you do not need a separate `spec wait` or `question wait` running beside it.";
const TOOL_ALONE =
  "When you do run one of those on its own — `spec push --wait`, `spec wait`, `question wait` — give the bash tool `timeout: 0`. Its deadline defaults to 300 seconds and ends the command with no signal it can catch, so the command stops without printing the cursor a restart would resume from, and whatever arrived in between is never read.";

/** The omp answer where the extension's tool is present (T-357). */
function ompToolParagraphs(): string[] {
  return [
    `running under omp, and the todou extension registers a \`${OMP_WATCH_TOOL}\` tool. It is mounted as a device rather than listed among your tools: write a call's JSON arguments to \`xd://${OMP_WATCH_TOOL}\` to run it, and read \`xd://${OMP_WATCH_TOOL}\` for its full documentation.`,
    '`{"action": "start", "issue": "T-16"}` follows one card; `{"action": "start"}` follows every card of a project. `{"action": "list"}` reports what is running, and `{"action": "stop", "id": "w1"}` ends one. `project` and `server` are optional — left out, each is resolved from the directory omp is running in, and a directory that settles neither fails the call rather than guessing. If you are working on a card, start a watch on that card now, so comments from other agents and from the user reach you while you are working.',
    TOOL_CARRIES,
    TOOL_ALONE,
  ];
}

/** pi exposes ordinary tools and delivers steering after the current tool batch. */
const PI_TOOL = [
  "running under pi, and the todou extension registers a `todou_watch` tool. Call it directly with JSON arguments.",
  '`{"action": "start", "issue": "T-16"}` follows one card; `{"action": "start"}` follows a project. `{"action": "list"}` reports running watches, and `{"action": "stop", "id": "w1"}` ends one. `project` and `server` default to the current directory. If you are working on a card, start a watch on it now.',
  "The tool owns the background process. Activity starts a turn when pi is idle, or arrives after the current tool batch finishes. pi has no background bash; use this tool to follow activity while you work.",
  TOOL_CARRIES,
];

const PI_POLL =
  "Use `todou issue watch` or `todou watch` with `--poll` to check once, then resume from the printed cursor. pi's bash tool cannot monitor a background stream while you work.";
/** The same question, with omp's own way of keeping the command running. */
const OMP_STREAM = [
  ...streamOrPoll(UNKNOWN_LEAD, UNKNOWN_FALLBACK, BACKGROUNDED.omp),
  OMP_DEADLINE,
];

const CLOSING =
  "Whichever mode you use, the watch carries spec and question activity too: a review verdict and a question answer each arrive on it as their own line, so you do not need a separate `spec wait` or `question wait` running beside it.";

/**
 * The answer when the push channel is there, said once for both harnesses
 * that have one. Only the name and the backgrounding clause differ, and two
 * copies of this paragraph would eventually differ in more than those.
 *
 * The id rather than the label, because both are read from it: `HARNESS_LABELS`
 * stays the one place a harness is spelled for a reader, and folding the clause
 * into it would make a display name carry a tool's parameter.
 */
function udsParagraphs(harness: "claude-code" | "omp"): string[] {
  return [
    `running under ${HARNESS_LABELS[harness]}, and \`--follow=uds\` is available.`,
    `Use it with \`todou watch\` or \`todou issue watch\`, ${BACKGROUNDED[harness]}. If you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.`,
    ...(harness === "omp" ? [OMP_DEADLINE] : []),
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
  /**
   * The tool names the extension published, if any. An extension that
   * has not been restarted after an update publishes the old list, and the
   * advice follows it — the tool genuinely is not there in that session.
   */
  tools?: readonly string[];
  optedOut: boolean;
}): FollowAdvice {
  const { harness, socket, tools, optedOut } = input;
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
    return advice("uds", udsParagraphs("claude-code"));
  }

  if (harness === "omp") {
    // States what was looked for and not found, and stops there. The two ways
    // an omp has no channel — no extension, and an extension too old to
    // publish one — are indistinguishable from here, and the branch that used
    // to name the first of them was simply wrong on a machine where the
    // extension was installed all along. Which of the two it is belongs to
    // `todou integration status`, which reads the file and reports the
    // version; naming an install command here would put a command an agent
    // can run into a report both agents and people read.
    if (!socket) {
      return advice("omp-no-peer", [
        "running under omp, but no omp above this process has published a todou push socket, so `--follow=uds` has no session to push to.",
        ...OMP_STREAM,
        CLOSING,
      ]);
    }
    if (optedOut) {
      return advice("uds-opted-out", [
        "running under omp, but `--follow=uds` is opted out on this machine.",
        ...OMP_STREAM,
        CLOSING,
      ]);
    }
    // After the opt-out, not before it: opting out says "do not push into
    // this session", and the tool pushes over the same channel — so it goes
    // with the channel rather than around it.
    if (tools?.includes(OMP_WATCH_TOOL)) {
      return advice("omp-tool", ompToolParagraphs());
    }
    return advice("uds", udsParagraphs("omp"));
  }

  if (harness === "pi") {
    if (socket && optedOut) {
      return advice("uds-opted-out", [
        "running under pi, but `--follow=uds` is opted out on this machine.",
        PI_POLL,
        CLOSING,
      ]);
    }
    if (socket && tools?.includes(OMP_WATCH_TOOL)) {
      return advice("pi-tool", PI_TOOL);
    }
    return advice("pi-no-tool", [
      "running under pi, but no pi session above this process has published a todou watch tool and push socket.",
      PI_POLL,
      CLOSING,
    ]);
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
