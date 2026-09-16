import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessMessaging } from "../../src/harness/messaging.ts";
import type { ProcessTreeIo } from "../../src/harness/process-tree.ts";
import { procTree, scratchDir } from "./proc-fixture.ts";

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
  it("reads Claude Code's pair under Claude Code, named as its receiver", () => {
    expect(
      read({
        CLAUDECODE: "1",
        CLAUDE_CODE_MESSAGING_SOCKET: CC,
        CLAUDE_CODE_MESSAGING_TOKEN: "cc-token",
      }),
    ).toEqual({ socket: CC, token: "cc-token", peer: "claude-code" });
  });

  it("keeps reading them with no harness detected at all", () => {
    // Every supervisor and wrapper that runs todou from inside a session
    // without carrying its markers, which is how this has always behaved.
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: CC })).toEqual({
      socket: CC,
      token: undefined,
      peer: "claude-code",
    });
  });

  it("reads todou's own pair under omp, named as its receiver", () => {
    expect(
      read({
        OMPCODE: "1",
        CLAUDECODE: "1",
        TODOU_MESSAGING_SOCKET: OMP,
        TODOU_MESSAGING_TOKEN: "omp-token",
      }),
    ).toEqual({ socket: OMP, token: "omp-token", peer: "omp" });
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

/*
 * omp exports the pair into its own bash tool's environment and nowhere else,
 * so every other context it spawns — the `!` shell above all, which is where a
 * person types `todou` — has to find the channel the same way it finds the
 * session: by asking which ancestor published a record about itself (T-312).
 */
describe("harnessMessaging under omp, with nothing in the environment", () => {
  /** The pid chain `[us, near, far]`, none of them carrying omp's markers. */
  const NEAR = 424242;
  const FAR = 424243;

  /**
   * A runtime directory with the records a case asks for, and the tree that
   * reaches them. Our own pid stands for nothing here: the records name
   * fixture pids, and only `alive()` would object — which is why every case
   * that expects a hit uses `process.pid` as the publisher.
   */
  function environment(records: Record<number, unknown>): {
    env: Record<string, string>;
    io: Partial<ProcessTreeIo>;
  } {
    const runtime = scratchDir("todou-msg-rt-");
    const dir = join(runtime, "todou-omp");
    mkdirSync(dir, { recursive: true });
    for (const [pid, body] of Object.entries(records)) {
      writeFileSync(join(dir, `${pid}.json`), JSON.stringify(body));
    }
    return {
      env: { OMPCODE: "1", CLAUDECODE: "1", XDG_RUNTIME_DIR: runtime },
      io: procTree([
        // Both markers, as omp really builds them, so that the tie between
        // the two matching harnesses is decided here the way it is in life.
        {
          pid: 1000,
          ppid: process.pid,
          env: { OMPCODE: "1", CLAUDECODE: "1" },
        },
        { pid: process.pid, ppid: NEAR, argv: ["omp"] },
        { pid: NEAR, ppid: FAR, argv: ["omp"] },
        { pid: FAR, ppid: 1, argv: ["omp"] },
      ]),
    };
  }

  const record = (pid: number, extra: object = {}) => ({
    v: 1,
    pid,
    agent: "omp",
    session_id: "01900000-0000-7000-8000-000000000001",
    updated_at: "2026-09-12T02:49:21.732Z",
    ...extra,
  });

  const channel = {
    socket: "/run/user/1000/todou-omp/9.sock",
    token: "t0ken",
    peer: "omp",
  } as const;

  it("takes the channel an ancestor published", () => {
    const { env, io } = environment({
      [process.pid]: record(process.pid, channel),
    });
    expect(harnessMessaging(env, io)).toEqual(channel);
  });

  it("reports no channel for an extension too old to publish one", () => {
    // Installed on real machines right now, and the record it writes still
    // carries a session id — so this must be "no channel", not "no record".
    const { env, io } = environment({ [process.pid]: record(process.pid) });
    expect(harnessMessaging(env, io)).toEqual({});
  });

  it("takes the nearer publisher when omp is running inside omp", () => {
    const far = "/run/user/1000/todou-omp/far.sock";
    const { env, io } = environment({
      [process.pid]: record(process.pid, channel),
      [FAR]: record(FAR, { socket: far, token: "far-token" }),
    });
    expect(harnessMessaging(env, io)).toEqual(channel);
  });

  it("keeps preferring the variable where omp did export it", () => {
    // The bash tool's own environment, with a published record beside it: the
    // variable is free to read and says the same thing.
    const { env, io } = environment({
      [process.pid]: record(process.pid, channel),
    });
    expect(
      harnessMessaging(
        { ...env, TODOU_MESSAGING_SOCKET: OMP, TODOU_MESSAGING_TOKEN: "env" },
        io,
      ),
    ).toEqual({ socket: OMP, token: "env", peer: "omp" });
  });
});

describe("harnessMessaging reads the extension's tools (T-357)", () => {
  const read = (env: Record<string, string>) => harnessMessaging(env, NO_TREE);

  it("takes them from the variable the bash tool carries", () => {
    expect(
      read({
        OMPCODE: "1",
        CLAUDECODE: "1",
        TODOU_MESSAGING_SOCKET: OMP,
        TODOU_OMP_TOOLS: "todou_watch",
      }).tools,
    ).toEqual(["todou_watch"]);
    // A comma list is the one shape `claim()` writes and this must split.
    expect(
      read({
        OMPCODE: "1",
        CLAUDECODE: "1",
        TODOU_MESSAGING_SOCKET: OMP,
        TODOU_OMP_TOOLS: "a,b",
      }).tools,
    ).toEqual(["a", "b"]);
  });

  it("takes them from a record an ancestor published", () => {
    const runtime = scratchDir("todou-msg-tools-");
    const dir = join(runtime, "todou-omp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({
        v: 1,
        pid: process.pid,
        agent: "omp",
        session_id: "01900000-0000-7000-8000-000000000001",
        socket: "/run/user/1000/todou-omp/9.sock",
        token: "t0ken",
        tools: ["todou_watch"],
        updated_at: "2026-09-12T02:49:21.732Z",
      }),
    );
    expect(
      harnessMessaging(
        { OMPCODE: "1", CLAUDECODE: "1", XDG_RUNTIME_DIR: runtime },
        procTree([{ pid: process.pid, ppid: 1, argv: ["omp"] }]),
      ).tools,
    ).toEqual(["todou_watch"]);
  });

  it("reads no tools where the record or variable named none", () => {
    expect(
      read({
        OMPCODE: "1",
        CLAUDECODE: "1",
        TODOU_MESSAGING_SOCKET: OMP,
      }).tools,
    ).toBeUndefined();
  });
});
