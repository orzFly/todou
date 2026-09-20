import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  harnessMessaging,
  nativeWatchOwner,
} from "../../src/harness/messaging.ts";
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

describe("pi messaging", () => {
  function environment(agent: string, extra: object = {}) {
    const runtime = scratchDir("todou-pi-msg-");
    const dir = join(runtime, "todou-omp");
    mkdirSync(dir, { recursive: true });
    const state = join(dir, `${process.pid}.json`);
    writeFileSync(
      state,
      JSON.stringify({
        v: 1,
        pid: process.pid,
        agent,
        session_id: "pi-session",
        socket: "/run/todou/pi.sock",
        token: "pi-token",
        tools: ["todou_watch"],
        ...extra,
      }),
    );
    return {
      env: { PI_CODING_AGENT: "true", XDG_RUNTIME_DIR: runtime },
      io: procTree([
        { pid: 1000, ppid: process.pid, env: { PI_CODING_AGENT: "true" } },
        { pid: process.pid, ppid: 1, argv: ["pi"] },
      ]),
    };
  }

  it("finds pi's published channel and tool by ancestry", () => {
    const { env, io } = environment("pi");
    expect(harnessMessaging(env, io)).toEqual({
      socket: "/run/todou/pi.sock",
      token: "pi-token",
      peer: "pi",
      tools: ["todou_watch"],
    });
  });

  it("rejects inherited omp and Claude Code endpoints", () => {
    const { env, io } = environment("omp");
    expect(
      harnessMessaging(
        {
          ...env,
          TODOU_MESSAGING_SOCKET: OMP,
          TODOU_MESSAGING_TOKEN: "outer-token",
          TODOU_OMP_TOOLS: "todou_watch",
          CLAUDE_CODE_MESSAGING_SOCKET: CC,
        },
        io,
      ),
    ).toEqual({});
  });

  it("rejects incomplete published channel pairs", () => {
    const { env, io } = environment("pi", { token: "" });
    expect(harnessMessaging(env, io)).toEqual({});
  });

  it.each(["pi", "omp"])(
    "does not route an unextended inner %s to its pi parent",
    (inner) => {
      const { env } = environment("pi");
      const inherited = {
        ...env,
        TODOU_PI_STATE: join(
          env.XDG_RUNTIME_DIR,
          "todou-omp",
          `${process.pid}.json`,
        ),
        TODOU_MESSAGING_SOCKET: "/run/todou/pi.sock",
        TODOU_MESSAGING_TOKEN: "pi-token",
        TODOU_PI_TOOLS: "todou_watch",
        PI_SESSION_ID: "outer-session",
      };
      const child =
        inner === "omp" ? { ...inherited, OMPCODE: "1" } : inherited;
      const io = procTree([
        { pid: 1000, ppid: 1001, env: child },
        {
          pid: 1001,
          ppid: process.pid,
          env: inherited,
          argv: [inner, "--no-extensions"],
        },
        { pid: process.pid, ppid: 1, argv: ["pi"] },
      ]);
      expect(harnessMessaging(child, io)).toEqual({});
    },
  );

  it("keeps an omp-owned channel when pi state is also inherited", () => {
    const { env } = environment("omp", { socket: OMP, token: "own-token" });
    const own = join(env.XDG_RUNTIME_DIR, "todou-omp", `${process.pid}.json`);
    const child = {
      ...env,
      OMPCODE: "1",
      TODOU_PI_STATE: "/nonexistent/outer.json",
      TODOU_OMP_STATE: own,
      TODOU_MESSAGING_SOCKET: OMP,
      TODOU_MESSAGING_TOKEN: "own-token",
      TODOU_OMP_TOOLS: "todou_watch",
    };
    const io = procTree([
      { pid: 1000, ppid: process.pid, env: child },
      {
        pid: process.pid,
        ppid: 1,
        env: { PI_CODING_AGENT: "true" },
        argv: ["omp"],
      },
    ]);
    expect(harnessMessaging(child, io)).toEqual({
      socket: OMP,
      token: "own-token",
      peer: "omp",
      tools: ["todou_watch"],
    });
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

  it("prefers the current manifest over stale exported credentials", () => {
    const { env, io } = environment({
      [process.pid]: record(process.pid, channel),
    });
    expect(
      harnessMessaging(
        { ...env, TODOU_MESSAGING_SOCKET: OMP, TODOU_MESSAGING_TOKEN: "env" },
        io,
      ),
    ).toEqual(channel);
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

describe("native messaging ownership", () => {
  function environment(peer: "omp" | "pi", pid = process.pid) {
    const runtime = scratchDir("todou-native-owner-");
    const dir = join(runtime, "todou-omp");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${pid}.json`);
    const record = {
      v: 1,
      pid,
      agent: peer,
      session_id: "native-session",
      socket: "/run/todou/native.sock",
      token: "current-token",
      tools: ["todou_watch"],
    };
    writeFileSync(path, JSON.stringify(record));
    const env: Record<string, string> = {
      XDG_RUNTIME_DIR: runtime,
      [peer === "omp" ? "OMPCODE" : "PI_CODING_AGENT"]:
        peer === "omp" ? "1" : "true",
      [peer === "omp" ? "TODOU_OMP_STATE" : "TODOU_PI_STATE"]: path,
      TODOU_MESSAGING_SOCKET: record.socket,
      TODOU_MESSAGING_TOKEN: "stale-token",
      TODOU_OMP_TOOLS: "obsolete_tool",
    };
    const io = procTree([
      { pid: 424240, ppid: pid, env },
      { pid, ppid: 1, argv: [peer] },
    ]);
    return { env, io, path, record, dir };
  }

  it.each(["omp", "pi"] as const)(
    "%s rereads the complete owner and channel after token/session rotation",
    (peer) => {
      const { env, io, path, record } = environment(peer);
      expect(nativeWatchOwner(env, io)).toEqual({
        peer,
        pid: process.pid,
        path,
        sessionId: record.session_id,
        socket: record.socket,
        token: record.token,
      });
      const rotated = {
        ...record,
        session_id: "next-session",
        token: "rotated-token",
        socket: "/run/todou/rotated.sock",
        tools: ["todou_watch", "todou_unwatch"],
      };
      writeFileSync(path, JSON.stringify(rotated));
      expect(nativeWatchOwner(env, io)).toEqual({
        peer,
        pid: process.pid,
        path,
        sessionId: rotated.session_id,
        socket: rotated.socket,
        token: rotated.token,
      });
      expect(harnessMessaging(env, io)).toEqual({
        peer,
        socket: rotated.socket,
        token: rotated.token,
        tools: rotated.tools,
      });
    },
  );

  it.each(["omp", "pi"] as const)(
    "%s loses its owner when its manifest disappears",
    (peer) => {
      const { env, io, path } = environment(peer);
      expect(nativeWatchOwner(env, io)).toBeDefined();
      unlinkSync(path);
      expect(nativeWatchOwner(env, io)).toBeUndefined();
      expect(harnessMessaging(env, io)).toEqual({});
    },
  );

  it.each(["{", "null", "[]", "42", '""', "{}"])(
    "treats malformed manifest %s as absent, without reviving stale env",
    (body) => {
      for (const peer of ["omp", "pi"] as const) {
        const { env, io, path } = environment(peer);
        writeFileSync(path, body);
        expect(nativeWatchOwner(env, io)).toBeUndefined();
        expect(harnessMessaging(env, io)).toEqual({});
      }
    },
  );

  it.each(["omp", "pi"] as const)(
    "%s rejects a manifest whose publisher has died since the previous read",
    async (peer) => {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      const exited = once(child, "exit");
      try {
        await once(child, "spawn");
        if (child.pid === undefined) throw new Error("Missing publisher PID");
        const { env, io } = environment(peer, child.pid);
        expect(nativeWatchOwner(env, io)).toBeDefined();
        child.kill("SIGTERM");
        await exited;
        expect(nativeWatchOwner(env, io)).toBeUndefined();
        expect(harnessMessaging(env, io)).toEqual({});
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    },
  );

  it.each(["omp", "pi"] as const)(
    "%s requires a complete channel in an otherwise valid manifest",
    (peer) => {
      const { env, io, path, record } = environment(peer);
      writeFileSync(path, JSON.stringify({ ...record, token: "" }));
      expect(nativeWatchOwner(env, io)).toBeUndefined();
      expect(harnessMessaging(env, io)).toEqual({});
    },
  );

  it.each(["omp", "pi"] as const)(
    "%s requires positive ancestry even for a live explicit manifest",
    (peer) => {
      const { env, record } = environment(peer);
      expect(harnessMessaging(env, NO_TREE).token).toBe(record.token);
      expect(nativeWatchOwner(env, NO_TREE)).toBeUndefined();
      const unrelated = procTree([
        { pid: 424240, ppid: 424241, env },
        { pid: 424241, ppid: 1, argv: [peer] },
      ]);
      expect(nativeWatchOwner(env, unrelated)).toBeUndefined();
    },
  );

  it("does not revive env credentials when an ancestry-only manifest is malformed", () => {
    const { env, io, path } = environment("omp");
    delete env.TODOU_OMP_STATE;
    writeFileSync(path, "null");
    expect(harnessMessaging(env, io)).toEqual({});
    expect(nativeWatchOwner(env, io)).toBeUndefined();
  });

  it("preserves env-only legacy omp messaging without inventing a watch owner", () => {
    const env = {
      OMPCODE: "1",
      XDG_RUNTIME_DIR: scratchDir("todou-legacy-"),
      TODOU_MESSAGING_SOCKET: OMP,
      TODOU_MESSAGING_TOKEN: "legacy-token",
      TODOU_OMP_TOOLS: "todou_watch",
    };
    const io = procTree([
      { pid: 424240, ppid: process.pid, env },
      { pid: process.pid, ppid: 1, argv: ["omp"] },
    ]);
    for (const tree of [NO_TREE, io]) {
      expect(harnessMessaging(env, tree)).toEqual({
        peer: "omp",
        socket: OMP,
        token: "legacy-token",
        tools: ["todou_watch"],
      });
      expect(nativeWatchOwner(env, tree)).toBeUndefined();
    }
  });

  it("accepts an owned legacy manifest without the agent field", () => {
    const { env, io, path, record } = environment("omp");
    writeFileSync(path, JSON.stringify({ ...record, agent: undefined }));
    expect(nativeWatchOwner(env, io)?.peer).toBe("omp");
    expect(harnessMessaging(env, io).token).toBe(record.token);
  });

  it.each([
    ["omp", "omp"],
    ["omp", "pi"],
    ["pi", "omp"],
    ["pi", "pi"],
  ] as const)(
    "an unextended inner %s never borrows its outer %s channel",
    (inner, outer) => {
      const { env: inherited, path } = environment(outer);
      const env = {
        ...inherited,
        [inner === "omp" ? "OMPCODE" : "PI_CODING_AGENT"]:
          inner === "omp" ? "1" : "true",
      };
      const io = procTree([
        { pid: 424240, ppid: 424241, env },
        {
          pid: 424241,
          ppid: process.pid,
          env: inherited,
          argv: [inner, "--no-extensions"],
        },
        { pid: process.pid, ppid: 1, argv: [outer] },
      ]);
      expect(harnessMessaging(env, io)).toEqual({});
      expect(nativeWatchOwner(env, io)).toBeUndefined();
      // Even when the outer host's file vanishes, its exported channel is
      // not a legacy channel belonging to the inner host.
      unlinkSync(path);
      expect(harnessMessaging(env, io)).toEqual({});
    },
  );

  it.each([
    ["omp", "omp"],
    ["omp", "pi"],
    ["pi", "omp"],
    ["pi", "pi"],
  ] as const)(
    "the nearer %s manifest wins over an inherited outer %s manifest",
    (inner, outer) => {
      const { env, path, record, dir } = environment(inner);
      const outerPath = join(dir, `${process.ppid}.json`);
      writeFileSync(
        outerPath,
        JSON.stringify({
          ...record,
          pid: process.ppid,
          agent: outer,
          session_id: "outer-session",
          token: "outer-token",
        }),
      );
      const inherited = {
        XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
        [outer === "omp" ? "OMPCODE" : "PI_CODING_AGENT"]:
          outer === "omp" ? "1" : "true",
        [outer === "omp" ? "TODOU_OMP_STATE" : "TODOU_PI_STATE"]: outerPath,
        TODOU_MESSAGING_SOCKET: record.socket,
        TODOU_MESSAGING_TOKEN: "outer-token",
      };
      const child = { ...env, ...inherited };
      const io = procTree([
        { pid: 424240, ppid: process.pid, env: child },
        { pid: process.pid, ppid: process.ppid, env: inherited, argv: [inner] },
        { pid: process.ppid, ppid: 1, argv: [outer] },
      ]);
      expect(harnessMessaging(child, io)).toEqual({
        peer: inner,
        socket: record.socket,
        token: record.token,
        tools: record.tools,
      });
      expect(nativeWatchOwner(child, io)?.path).toBe(path);
    },
  );

  it.each([
    ["omp", "omp"],
    ["omp", "pi"],
    ["pi", "omp"],
    ["pi", "pi"],
  ] as const)(
    "an unmarked shell under inner %s cannot borrow outer %s",
    (inner, outer) => {
      const { env: inherited } = environment(outer);
      const env = {
        ...inherited,
        [inner === "omp" ? "OMPCODE" : "PI_CODING_AGENT"]:
          inner === "omp" ? "1" : "true",
      };
      for (const hostEnv of [inherited, {}]) {
        const io = procTree([
          { pid: 424240, ppid: 424241, env: {}, argv: ["sh"] },
          {
            pid: 424241,
            ppid: process.pid,
            env: hostEnv,
            argv: [inner, "--no-extensions"],
          },
          { pid: process.pid, ppid: 1, argv: [outer] },
        ]);
        expect(harnessMessaging(env, io)).toEqual({});
        expect(nativeWatchOwner(env, io)).toBeUndefined();
      }
    },
  );

  it("finds the owner beyond an unmarked omp eval worker", () => {
    const { env, record, path } = environment("omp");
    const bare = { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR };
    const io = procTree([
      {
        pid: 424240,
        ppid: process.pid,
        env: {},
        argv: ["omp", "__omp_worker_js_eval_process"],
      },
      { pid: process.pid, ppid: 1, argv: ["omp"] },
    ]);
    expect(harnessMessaging(bare, io)).toEqual({
      peer: "omp",
      socket: record.socket,
      token: record.token,
      tools: record.tools,
    });
    expect(nativeWatchOwner(bare, io)?.path).toBe(path);
  });

  it("does not borrow an outer omp manifest through an unmarked clean inner host", () => {
    const { env: inherited } = environment("omp");
    const clean = {
      XDG_RUNTIME_DIR: inherited.XDG_RUNTIME_DIR,
      PI_CODING_AGENT_DIR: scratchDir("todou-clean-inner-agent-"),
    };
    const io = procTree([
      { pid: 424240, ppid: 424241, env: clean, argv: ["sh"] },
      {
        pid: 424241,
        ppid: process.pid,
        env: clean,
        argv: ["omp"],
      },
      { pid: process.pid, ppid: 1, argv: ["omp"] },
    ]);
    expect(harnessMessaging(clean, io)).toEqual({});
    expect(nativeWatchOwner(clean, io)).toBeUndefined();
  });

  it("preserves a legacy env channel alongside an owned identity-only manifest", () => {
    const { env, io, path, record } = environment("omp");
    writeFileSync(
      path,
      JSON.stringify({ ...record, socket: undefined, token: undefined }),
    );
    expect(harnessMessaging(env, io)).toEqual({
      peer: "omp",
      socket: env.TODOU_MESSAGING_SOCKET,
      token: env.TODOU_MESSAGING_TOKEN,
      tools: ["obsolete_tool"],
    });
    expect(nativeWatchOwner(env, io)).toBeUndefined();
  });

  it("does not treat an inherited legacy omp channel as an inner host's channel", () => {
    const inherited = {
      OMPCODE: "1",
      XDG_RUNTIME_DIR: scratchDir("todou-legacy-nested-"),
      TODOU_MESSAGING_SOCKET: OMP,
      TODOU_MESSAGING_TOKEN: "outer-token",
    };
    const io = procTree([
      { pid: 424240, ppid: 424241, env: inherited },
      { pid: 424241, ppid: process.pid, env: inherited, argv: ["omp"] },
      { pid: process.pid, ppid: 1, argv: ["omp"] },
    ]);
    expect(harnessMessaging(inherited, io)).toEqual({});
    expect(nativeWatchOwner(inherited, io)).toBeUndefined();
  });
});
