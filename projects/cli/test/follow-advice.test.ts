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

  it("offers uds under omp once its extension is installed", () => {
    expect(
      followAdvice({ harness: "omp", socket: SOCKET, optedOut: false }),
    ).toEqual({
      situation: "uds",
      harness: "omp",
      paragraphs: [
        "running under omp, and `--follow=uds` is available.",
        "Use it with `todou watch` or `todou issue watch`, started as a background task (run in background = true). If you are working on a card, start an issue watch on that card now, so comments from other agents and from the user reach you while you are working.",
        CLOSING,
      ],
    });
  });

  it("names the install command when omp has no extension", () => {
    // The one situation whose way out belongs to the reader: installing a
    // per-user extension changes nothing for anyone else, unlike the opt-out
    // above, which is the user's standing decision about this machine.
    expect(
      followAdvice({ harness: "omp", socket: undefined, optedOut: false }),
    ).toEqual({
      situation: "omp-not-installed",
      harness: "omp",
      paragraphs: [
        "running under omp, but the todou extension is not installed in it, so there is no session socket to push to.",
        "Run `todou integration install omp` and restart omp — the extension also lets todou read which session omp is in, instead of inferring it from session-log timestamps.",
        ...UNKNOWN_HARNESS,
        CLOSING,
      ],
    });
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
        ...UNKNOWN_HARNESS,
        CLOSING,
      ],
    });
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
