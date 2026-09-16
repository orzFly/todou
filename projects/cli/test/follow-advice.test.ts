import { describe, expect, it } from "vitest";
import { followAdvice } from "../src/follow-advice.ts";

/**
 * Whole-array equality throughout, not substring probes: this wording was
 * reviewed sentence by sentence (T-259), and an edit to it should fail a test
 * rather than slip past one.
 */

const SOCKET = "/run/cc-socks/4242.sock";

const STREAM_OR_POLL_TAIL =
  "Either watch, run without `--follow`, blocks, returns one batch and exits; re-open it from the cursor it printed. `--poll` checks once without blocking.";

const MONITOR = [
  "If you have a Monitor tool — anything that keeps reading a running command's output and wakes you on it — use `--follow=stdout` with `todou watch` or `todou issue watch`, and if you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.",
  `Without one you cannot use follow at all: use poll mode. ${STREAM_OR_POLL_TAIL}`,
];

const UNKNOWN_HARNESS = [
  "If you can watch a stream continuously and be woken by what it writes, try `--follow=stdout` with `todou watch` or `todou issue watch`, and if you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.",
  `If you cannot, use poll mode. ${STREAM_OR_POLL_TAIL}`,
];

/** The same question put to omp, which is told how to background the watch. */
const ASYNC =
  "started with the bash tool's `async: true` and `timeout: 0` (`hub` is where you see how that job is doing)";
const OMP_DEADLINE =
  "`timeout: 0` is what keeps that job alive: the bash tool's deadline defaults to 300 seconds and ends the command with no signal it can catch, so a watch that reaches it stops without printing the cursor a restart would resume from, and whatever arrived in between is never read. Every todou command that has to outlive a single tool call takes the same parameter — `spec push --wait`, `spec wait`, `question wait`, and any watch run with `--forever`.";
const OMP_STREAM = [
  `If you can watch a stream continuously and be woken by what it writes, try \`--follow=stdout\` with \`todou watch\` or \`todou issue watch\`, ${ASYNC}, and if you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.`,
  `If you cannot, use poll mode. ${STREAM_OR_POLL_TAIL}`,
  OMP_DEADLINE,
];

const CLOSING =
  "Whichever mode you use, the watch carries spec and question activity too: a review verdict and a question answer each arrive on it as their own line, so you do not need a separate `spec wait` or `question wait` running beside it.";

describe("followAdvice", () => {
  it("offers uds under Claude Code with a socket", () => {
    expect(
      followAdvice({
        harness: "claude-code",
        socket: SOCKET,
        optedOut: false,
      }),
    ).toEqual({
      situation: "uds",
      harness: "claude-code",
      paragraphs: [
        "running under Claude Code, and `--follow=uds` is available.",
        "Use it with `todou watch` or `todou issue watch`, started as a background task (run in background = true). If you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.",
        CLOSING,
      ],
    });
  });

  it("names the opt-out as the reason, not a missing socket", () => {
    // The peer is there; blaming CLAUDE_CODE_MESSAGING_SOCKET would send the
    // reader looking at the wrong thing.
    expect(
      followAdvice({ harness: "claude-code", socket: SOCKET, optedOut: true }),
    ).toEqual({
      situation: "uds-opted-out",
      harness: "claude-code",
      paragraphs: [
        "running under Claude Code, but `--follow=uds` is opted out on this machine.",
        ...MONITOR,
        CLOSING,
      ],
    });
  });

  it("falls back to the Monitor advice when no session exported a socket", () => {
    expect(
      followAdvice({
        harness: "claude-code",
        socket: undefined,
        optedOut: false,
      }),
    ).toEqual({
      situation: "claude-code-no-peer",
      harness: "claude-code",
      paragraphs: [
        "running under Claude Code, but CLAUDE_CODE_MESSAGING_SOCKET is not set in this process, so `--follow=uds` has no session to push to.",
        ...MONITOR,
        CLOSING,
      ],
    });
  });

  it("offers uds under omp, in omp's own words for a background job", () => {
    expect(
      followAdvice({ harness: "omp", socket: SOCKET, optedOut: false }),
    ).toEqual({
      situation: "uds",
      harness: "omp",
      paragraphs: [
        "running under omp, and `--follow=uds` is available.",
        `Use it with \`todou watch\` or \`todou issue watch\`, ${ASYNC}. If you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.`,
        OMP_DEADLINE,
        CLOSING,
      ],
    });
  });

  it("states the missing publisher under omp, and nothing beyond it", () => {
    // What this used to say — that the extension is not installed — is not
    // something this can tell: a machine with the extension installed and its
    // socket listening reaches here whenever omp's curated environment did not
    // carry the pair. So the report names only what was looked for.
    expect(
      followAdvice({ harness: "omp", socket: undefined, optedOut: false }),
    ).toEqual({
      situation: "omp-no-peer",
      harness: "omp",
      paragraphs: [
        "running under omp, but no omp above this process has published a todou push socket, so `--follow=uds` has no session to push to.",
        ...OMP_STREAM,
        CLOSING,
      ],
    });
  });

  it("never names the extension or a command to install it", () => {
    // The extension is the path T-308 laid for an agent to be installed along,
    // not an instruction to hand whoever reads this — and both agents and
    // people read it. Which of the two omp channel-less states this is belongs
    // to `todou integration status`, which can actually tell them apart.
    for (const advice of [
      followAdvice({ harness: "omp", socket: undefined, optedOut: false }),
      followAdvice({ harness: "omp", socket: SOCKET, optedOut: true }),
      followAdvice({ harness: "omp", socket: SOCKET, optedOut: false }),
    ]) {
      const text = advice.paragraphs.join("\n");
      expect(text).not.toContain("install");
      expect(text).not.toContain("extension");
    }
  });

  it("does not tell an opted-out omp to install anything", () => {
    // The extension would change nothing about the opt-out, so naming it here
    // would send the reader to run a command with no effect on their problem.
    expect(
      followAdvice({ harness: "omp", socket: SOCKET, optedOut: true }),
    ).toEqual({
      situation: "uds-opted-out",
      harness: "omp",
      paragraphs: [
        "running under omp, but `--follow=uds` is opted out on this machine.",
        ...OMP_STREAM,
        CLOSING,
      ],
    });
  });

  it("keeps Claude Code's own parameter name off omp, and omp's off it", () => {
    // Each one names a tool parameter that exists only in the other harness;
    // an agent handed the wrong one looks for something that is not there.
    const omp = followAdvice({
      harness: "omp",
      socket: SOCKET,
      optedOut: false,
    }).paragraphs.join("\n");
    expect(omp).toContain("async: true");
    expect(omp).not.toContain("run in background");
    // The deadline is omp's bash tool's, and the paragraph about it has to
    // reach every omp situation without leaking into a harness whose
    // background task has no such parameter.
    expect(omp).toContain("timeout: 0");

    const cc = followAdvice({
      harness: "claude-code",
      socket: SOCKET,
      optedOut: false,
    }).paragraphs.join("\n");
    expect(cc).toContain("run in background");
    expect(cc).not.toContain("async");
    expect(cc).not.toContain("timeout: 0");
  });

  it("says what it does not know about another harness, by name", () => {
    expect(
      followAdvice({ harness: "codex", socket: undefined, optedOut: false }),
    ).toEqual({
      situation: "known-harness",
      harness: "codex",
      paragraphs: [
        "running under Codex, but whether it can monitor a background command's stdout is not something todou knows.",
        ...UNKNOWN_HARNESS,
        CLOSING,
      ],
    });
  });

  it("says the same about no harness at all", () => {
    expect(
      followAdvice({ harness: null, socket: undefined, optedOut: false }),
    ).toEqual({
      situation: "no-harness",
      harness: null,
      paragraphs: [
        "no agent harness detected, so what this environment does with a long-running command is not something todou knows.",
        ...UNKNOWN_HARNESS,
        CLOSING,
      ],
    });
  });

  it("keeps the opt-out from deciding anything a missing socket already decided", () => {
    // Opted out and no peer either: the socket is the fact that can be acted
    // on, so it is the one reported.
    expect(
      followAdvice({
        harness: "claude-code",
        socket: undefined,
        optedOut: true,
      }).situation,
    ).toBe("claude-code-no-peer");
    // A socket set to the empty string is unset as far as `followTransport`
    // is concerned, and the two must agree or one of them is lying.
    expect(
      followAdvice({ harness: "claude-code", socket: "", optedOut: false })
        .situation,
    ).toBe("claude-code-no-peer");
  });

  it("names no way back out of the opt-out, in any situation", () => {
    for (const situation of [
      followAdvice({ harness: "claude-code", socket: SOCKET, optedOut: true }),
      followAdvice({ harness: "claude-code", socket: SOCKET, optedOut: false }),
      followAdvice({
        harness: "claude-code",
        socket: undefined,
        optedOut: false,
      }),
      followAdvice({ harness: "pi", socket: undefined, optedOut: false }),
      followAdvice({ harness: null, socket: undefined, optedOut: false }),
    ]) {
      const text = situation.paragraphs.join("\n");
      expect(text).not.toContain("opt-in-uds");
      expect(text).not.toContain("opt-out-uds");
    }
  });

  it("never presents uds as available once it is opted out", () => {
    const text = followAdvice({
      harness: "claude-code",
      socket: SOCKET,
      optedOut: true,
    })
      .paragraphs.join("\n")
      // The one mention it is allowed is the sentence saying it is off.
      .replace(
        "running under Claude Code, but `--follow=uds` is opted out on this machine.",
        "",
      );
    expect(text).not.toContain("--follow=uds");
  });
});

/** The four paragraphs of the omp-with-tool answer, pinned whole. */
const OMP_TOOL = [
  "running under omp, and the todou extension registers a `todou_watch` tool. It is mounted as a device rather than listed among your tools: write a call's JSON arguments to `xd://todou_watch` to run it, and read `xd://todou_watch` for its full documentation.",
  '`{"action": "start", "issue": "T-16"}` follows one card; `{"action": "start"}` follows every card of a project. `{"action": "list"}` reports what is running, and `{"action": "stop", "id": "w1"}` ends one. `project` and `server` are optional — left out, each is resolved from the directory omp is running in, and a directory that settles neither fails the call rather than guessing. If you are working on a card, start a watch on that card now, so comments from other agents and from the user reach you while you are working.',
  "The watch carries spec and question activity too: a review verdict and a question answer each arrive on it as their own line, so you do not need a separate `spec wait` or `question wait` running beside it.",
  "When you do run one of those on its own — `spec push --wait`, `spec wait`, `question wait` — give the bash tool `timeout: 0`. Its deadline defaults to 300 seconds and ends the command with no signal it can catch, so the command stops without printing the cursor a restart would resume from, and whatever arrived in between is never read.",
];

describe("followAdvice with the extension's tool present", () => {
  it("answers with the tool's four paragraphs, pinned sentence by sentence", () => {
    expect(
      followAdvice({
        harness: "omp",
        socket: SOCKET,
        tools: ["todou_watch"],
        optedOut: false,
      }),
    ).toEqual({
      situation: "omp-tool",
      harness: "omp",
      paragraphs: OMP_TOOL,
    });
  });

  it("mentions no other way to follow, in any of the four paragraphs", () => {
    // The promise this situation makes: the tool is the way. A `--follow`
    // or a `poll` in these paragraphs would offer a second one, and the
    // review that fixed them to four paragraphs did so against exactly
    // that. `timeout: 0` stays — it is about the other waits, not this one.
    const text = OMP_TOOL.join("\n");
    expect(text).not.toContain("--follow");
    expect(text).not.toContain("stdout");
    expect(text).not.toContain("poll");
  });

  it("keeps the uds answer where no tools were published", () => {
    // An extension one version behind publishes no tools: the tool genuinely
    // is not there in that session, so the old advice stays.
    expect(
      followAdvice({ harness: "omp", socket: SOCKET, optedOut: false }),
    ).toEqual({
      situation: "uds",
      harness: "omp",
      paragraphs: [
        "running under omp, and `--follow=uds` is available.",
        `Use it with \`todou watch\` or \`todou issue watch\`, ${ASYNC}. If you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.`,
        OMP_DEADLINE,
        CLOSING,
      ],
    });
    expect(
      followAdvice({
        harness: "omp",
        socket: SOCKET,
        tools: ["some_other_tool"],
        optedOut: false,
      }).situation,
    ).toBe("uds");
  });

  it("lets the opt-out win over the tool", () => {
    // The tool pushes over the same channel the opt-out refuses, so it
    // follows the channel down rather than around it.
    expect(
      followAdvice({
        harness: "omp",
        socket: SOCKET,
        tools: ["todou_watch"],
        optedOut: true,
      }).situation,
    ).toBe("uds-opted-out");
  });
});
