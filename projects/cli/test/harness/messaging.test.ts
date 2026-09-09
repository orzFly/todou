import { describe, expect, it } from "vitest";
import { harnessMessaging } from "../../src/harness/messaging.ts";
import type { ProcessTreeIo } from "../../src/harness/process-tree.ts";

/** No ancestors to attribute a marker to, so the environment alone decides. */
const NO_TREE: Partial<ProcessTreeIo> = {
  platform: "linux",
  procRoot: "/nonexistent",
  startPid: 0,
};

const CC = "/run/cc-socks/4242.sock";
const OMP = "/run/omp-socks/7331.sock";

const read = (env: Record<string, string>) => harnessMessaging(env, NO_TREE);

describe("harnessMessaging", () => {
  it("reads Claude Code's pair under Claude Code", () => {
    expect(
      read({
        CLAUDECODE: "1",
        CLAUDE_CODE_MESSAGING_SOCKET: CC,
        CLAUDE_CODE_MESSAGING_TOKEN: "cc-token",
      }),
    ).toEqual({ socket: CC, token: "cc-token" });
  });

  it("keeps reading them with no harness detected at all", () => {
    // Every supervisor and wrapper that runs todou from inside a session
    // without carrying its markers, which is how this has always behaved.
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: CC })).toEqual({
      socket: CC,
      token: undefined,
    });
  });

  it("reads todou's own pair under omp", () => {
    expect(
      read({
        OMPCODE: "1",
        CLAUDECODE: "1",
        TODOU_MESSAGING_SOCKET: OMP,
        TODOU_MESSAGING_TOKEN: "omp-token",
      }),
    ).toEqual({ socket: OMP, token: "omp-token" });
  });

  /**
   * The case worth having a test for. omp sets `CLAUDECODE=1` itself, and an
   * omp started from a Claude Code session also inherits that session's
   * socket — so the naive read finds an endpoint, pushes to it, and delivers
   * a card's activity to an agent that never asked while the one that ran the
   * watch waits for a batch that already went somewhere else.
   */
  it("never pushes an omp session's batches at the Claude Code above it", () => {
    expect(
      read({
        OMPCODE: "1",
        CLAUDECODE: "1",
        CLAUDE_CODE_MESSAGING_SOCKET: CC,
        CLAUDE_CODE_MESSAGING_TOKEN: "cc-token",
      }),
    ).toEqual({ socket: undefined, token: undefined });
  });

  it("gives a channel-less harness no endpoint, inherited or not", () => {
    // Codex publishes nothing to push into, and the socket it inherited from
    // the Claude Code that started it addresses that session, not this agent.
    expect(
      read({ CODEX_THREAD_ID: "t1", CLAUDE_CODE_MESSAGING_SOCKET: CC }),
    ).toEqual({});
  });
});
