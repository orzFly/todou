import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  detectAgentContext,
  detectHarnessId,
} from "../../src/harness/index.ts";
import type { ProcessTreeIo } from "../../src/harness/process-tree.ts";

/* Only same-uid ancestors are attributable, so fixtures speak as us. */
const UID = process.getuid?.() ?? 0;

const CLAUDE = { CLAUDECODE: "1" };
const CODEX = { CODEX_THREAD_ID: "00000000-0000-7000-8000-000000000001" };
const PI = { PI_CODING_AGENT: "true" };
const HERMES = { HERMES_REAL_HOME: "/home/todou" };

type Proc = {
  pid: number;
  ppid: number;
  uid?: number;
  env?: Record<string, string>;
  argv?: string[];
  cwd?: string;
  comm?: string;
};

/* ------------------------------------------------------------- Linux */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fake /proc holding exactly the chain a test cares about. */
function procTree(procs: Proc[]): Partial<ProcessTreeIo> {
  const root = mkdtempSync(join(tmpdir(), "todou-proc-"));
  roots.push(root);
  for (const p of procs) {
    const dir = join(root, String(p.pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stat"),
      `${p.pid} (${p.comm ?? "proc"}) S ${p.ppid} 0 0 0 -1 0 0 0 0 0 0 0`,
    );
    writeFileSync(
      join(dir, "environ"),
      `${Object.entries(p.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\0")}\0`,
    );
    writeFileSync(join(dir, "cmdline"), `${(p.argv ?? ["proc"]).join("\0")}\0`);
    if (p.cwd) symlinkSync(p.cwd, join(dir, "cwd"));
  }
  return {
    platform: "linux",
    procRoot: root,
    startPid: procs[0]?.pid ?? 1,
  };
}

/** A /proc with nothing in it: the "no process tree" degradation. */
function noTree(): Partial<ProcessTreeIo> {
  return procTree([]);
}

/* ------------------------------------------------------------- macOS */

function psTree(procs: Proc[]): {
  io: Partial<ProcessTreeIo>;
  calls: () => number;
} {
  let calls = 0;
  const ps = (args: readonly string[]): string => {
    calls++;
    if (args[0] === "-Ao") {
      return procs
        .map((p) => `  ${p.pid} ${p.ppid} ${p.uid ?? UID}`)
        .join("\n");
    }
    const wanted = new Set(
      (args[args.length - 1] as string).split(",").map(Number),
    );
    return procs
      .filter((p) => wanted.has(p.pid))
      .map((p) =>
        [
          p.pid,
          ...(p.argv ?? ["proc"]),
          ...Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`),
        ].join(" "),
      )
      .join("\n");
  };
  return {
    io: { platform: "darwin", startPid: procs[0]?.pid ?? 1, ps },
    calls: () => calls,
  };
}

describe("process-tree arbitration", () => {
  it("picks the inner harness when claude code launched codex", () => {
    // The shell codex spawned carries both; codex itself carries only what it
    // inherited, which is what marks it as the one that introduced the rest.
    const io = procTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX } },
      { pid: 101, ppid: 102, env: { ...CLAUDE } },
      { pid: 102, ppid: 103, env: { ...CLAUDE } },
      { pid: 103, ppid: 0, env: {} },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("codex");
  });

  it("picks the inner harness when codex launched claude code", () => {
    const io = procTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX } },
      { pid: 101, ppid: 102, env: { ...CODEX } },
      { pid: 102, ppid: 103, env: { ...CODEX } },
      { pid: 103, ppid: 0, env: {} },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("claude-code");
  });

  it("picks pi over the claude code session that launched it", () => {
    const io = procTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...PI } },
      { pid: 101, ppid: 102, env: { ...CLAUDE } },
      { pid: 102, ppid: 0, env: {} },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...PI }, io)).toBe("pi");
  });

  it("picks hermes over the claude code session it spawned from", () => {
    // The registry puts hermes last, so this can only come from the tree.
    const io = procTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...HERMES } },
      { pid: 101, ppid: 102, env: { ...CLAUDE } },
      { pid: 102, ppid: 0, env: {} },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...HERMES }, io)).toBe("hermes-agent");
  });

  it("reads a ppid past a comm holding spaces and parentheses", () => {
    const io = procTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX }, comm: "we (ird) p" },
      { pid: 101, ppid: 0, env: { ...CLAUDE } },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("codex");
  });

  it("falls back to the registry order with no process tree", () => {
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, noTree())).toBe(
      "claude-code",
    );
  });

  it("falls back to the registry order on an unreadable ancestor", () => {
    // The chain ends at the process whose environ cannot be read, leaving
    // both markers unattributed rather than half-attributed.
    const io = procTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX } },
      { pid: 101, ppid: 999, env: { ...CLAUDE, ...CODEX } },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("claude-code");
  });

  it("falls back to the registry order when nothing is attributable", () => {
    // Every visible ancestor carries both markers: they were introduced
    // outside the chain — a container boundary, or a permanent export.
    const io = procTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX } },
      { pid: 101, ppid: 0, env: { ...CLAUDE, ...CODEX } },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("claude-code");
  });

  it("falls back to the registry order when two hosts sit at one depth", () => {
    const io = procTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX } },
      { pid: 101, ppid: 0, env: {} },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("claude-code");
  });

  it("stops at a depth limit instead of following a cycle", () => {
    const procs: Proc[] = [];
    for (let i = 0; i < 40; i++) {
      procs.push({
        pid: 100 + i,
        ppid: 101 + i,
        env: { ...CLAUDE, ...CODEX },
      });
    }
    // The only ancestor lacking a marker sits below the cap, so neither
    // harness is attributable and the order decides.
    procs.push({ pid: 140, ppid: 0, env: {} });
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, procTree(procs))).toBe(
      "claude-code",
    );
  });

  it("reads no process tree on any platform without one", () => {
    const { io, calls } = psTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX } },
      { pid: 101, ppid: 0, env: { ...CLAUDE } },
    ]);
    expect(
      detectHarnessId({ ...CLAUDE, ...CODEX }, { ...io, platform: "win32" }),
    ).toBe("claude-code");
    expect(calls()).toBe(0);
  });
});

describe("process-tree cost", () => {
  const chain = (): Proc[] => [
    { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX } },
    { pid: 101, ppid: 102, env: { ...CLAUDE } },
    { pid: 102, ppid: 0, env: {} },
  ];

  it("reads nothing at all outside every harness", () => {
    const { io, calls } = psTree(chain());
    expect(detectHarnessId({}, io)).toBeNull();
    expect(calls()).toBe(0);
  });

  it("reads nothing when a single harness signals", () => {
    const { io, calls } = psTree(chain());
    expect(detectHarnessId(CLAUDE, io)).toBe("claude-code");
    expect(calls()).toBe(0);
  });

  it("spends exactly two ps calls to break a tie", () => {
    const { io, calls } = psTree(chain());
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("codex");
    expect(calls()).toBe(2);
  });

  it("does not cache an injected tree across calls", () => {
    const { io, calls } = psTree(chain());
    detectHarnessId({ ...CLAUDE, ...CODEX }, io);
    detectHarnessId({ ...CLAUDE, ...CODEX }, io);
    expect(calls()).toBe(4);
  });

  it("stops the chain at a uid that is not ours", () => {
    const { io } = psTree([
      { pid: 100, ppid: 101, env: { ...CLAUDE, ...CODEX } },
      { pid: 101, ppid: 102, uid: UID + 1, env: { ...CLAUDE } },
      { pid: 102, ppid: 0, env: {} },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("claude-code");
  });
});

describe("macOS ps parsing", () => {
  it("keeps markers straight when a value holds spaces", () => {
    // `ps -E` prints argv and the environment run together, and a value with
    // spaces is split across tokens — as SSH_CLIENT always is.
    const { io } = psTree([
      {
        pid: 100,
        ppid: 101,
        argv: ["/bin/zsh", "-c", "todou whoami"],
        env: {
          SSH_CLIENT: "203.0.113.1 60020 22",
          ...CLAUDE,
          ...CODEX,
          LANG: "en_US.UTF-8",
        },
      },
      {
        pid: 101,
        ppid: 0,
        argv: ["/opt/harness/bin/codex"],
        env: { SSH_CLIENT: "203.0.113.1 60020 22", ...CLAUDE },
      },
    ]);
    expect(detectHarnessId({ ...CLAUDE, ...CODEX }, io)).toBe("codex");
  });

  it("carries the host argv through to a detector", () => {
    const home = mkdtempSync(join(tmpdir(), "todou-pt-home-"));
    roots.push(home);
    const flat = mkdtempSync(join(tmpdir(), "todou-pt-flat-"));
    roots.push(flat);
    const project = mkdtempSync(join(tmpdir(), "todou-pt-project-"));
    roots.push(project);
    writeFileSync(
      join(flat, "session.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "01900000-0000-7000-8000-00000000000a",
        cwd: project,
      })}\n`,
    );
    const { io } = psTree([
      { pid: 100, ppid: 101, env: { ...PI } },
      {
        pid: 101,
        ppid: 0,
        argv: ["node", "/opt/harness/pi/cli.js", "--session-dir", flat],
        env: {},
      },
    ]);
    expect(detectAgentContext(PI, home, project, io)).toEqual({
      agent: "pi",
      session_id: "01900000-0000-7000-8000-00000000000a",
    });
  });
});
