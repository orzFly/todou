import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ompExtension, {
  type ExtensionHost,
} from "../../src/integrations/omp/extension.ts";
import piExtension from "../../src/integrations/pi/extension.ts";

type Handler = Parameters<ExtensionHost["on"]>[1];
type Context = Parameters<Handler>[1];
type Tool = Parameters<ExtensionHost["registerTool"]>[0];
type Agent = "omp" | "pi";
type ChildRecord = { pid: number; session: string; token: string };
type Channel = {
  state: string;
  socket: string;
  token: string;
  session_id: string;
};

let dir: string;
let savedEnv: NodeJS.ProcessEnv;
const disposers: Array<() => Promise<void>> = [];
const sockets = new Set<Socket>();
const socketWitnesses = new Map<Socket, string>();
const poll = { timeout: 5000, interval: 20 };
const completed = [
  "session_switch",
  "session_branch",
  "session_tree",
  "session_start",
  "agent_start",
];

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "todou-lifecycle-"));
  mkdirSync(join(dir, "children"));
  process.env.XDG_RUNTIME_DIR = dir;
  process.env.TODOU_WATCH_START_GRACE_MS = "150";
  for (const key of [
    "TODOU_OMP_STATE",
    "TODOU_OMP_TOOLS",
    "TODOU_PI_STATE",
    "TODOU_PI_TOOLS",
    "TODOU_MESSAGING_SOCKET",
    "TODOU_MESSAGING_TOKEN",
    "TODOU_TEST_IGNORE_TERM",
  ])
    delete process.env[key];
  const child = join(dir, "child.mjs");
  writeFileSync(
    child,
    `import { readFileSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  if (process.env.TODOU_TEST_IGNORE_TERM !== "1") process.exit(0);
});
setInterval(() => {}, 60000);
const state = process.env.TODOU_PI_STATE || process.env.TODOU_OMP_STATE;
writeFileSync(${JSON.stringify(join(dir, "children"))} + "/" + process.pid,
  JSON.stringify({ pid: process.pid, session: JSON.parse(readFileSync(state, "utf8")).session_id,
    token: process.env.TODOU_MESSAGING_TOKEN }));
`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const bin = join(dir, "todou");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(child)} "$@"\n`,
    { mode: 0o755 },
  );
  process.env.TODOU_BIN = bin;
});

function children(): ChildRecord[] {
  return readdirSync(join(dir, "children")).map((name) =>
    JSON.parse(readFileSync(join(dir, "children", name), "utf8")),
  );
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Opt-in evidence for mutation runs; reports observations before acceptance
// assertions and never prints credentials. Main owns running those mutations.
function witness(label: string, channel?: Channel) {
  const socketStates = [...socketWitnesses].map(([socket, label]) => ({
    label,
    destroyed: socket.destroyed,
    readyState: socket.readyState,
  }));
  if (process.env.TODOU_LIFECYCLE_WITNESS !== "1") return;
  console.log(
    JSON.stringify({
      witness: label,
      socketStates,
      source: createHash("sha256")
        .update(
          readFileSync(
            new URL("../../src/integrations/omp/extension.ts", import.meta.url),
          ),
        )
        .digest("hex"),
      children: children().map(({ pid, session }) => ({
        pid,
        session,
        alive: alive(pid),
      })),
      stateExists: channel && existsSync(channel.state),
      socketExists: channel && existsSync(channel.socket),
      session:
        channel && existsSync(channel.state)
          ? JSON.parse(readFileSync(channel.state, "utf8")).session_id
          : null,
    }),
  );
}

async function boundedLifecycle(operation: Promise<void>, label: string) {
  // This deadline detects a real child refusing to exit, including deliberately
  // broken mutation copies. Fake timers cannot bound a platform process wait.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          witness(`${label}:timed-out`);
          reject(
            new Error(
              `${label} did not settle within 2500ms; live fixture PIDs: ${children()
                .filter(({ pid }) => alive(pid))
                .map(({ pid }) => pid)
                .join(", ")}`,
            ),
          );
        }, 2500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  const disposing = Promise.all(
    disposers
      .splice(0)
      .reverse()
      .map((dispose) => dispose()),
  ).then(() => {});
  try {
    try {
      await boundedLifecycle(disposing, "teardown");
    } finally {
      // Even a mutation that removes stop() must never strand owned children.
      // Killing them also releases transitions waiting on their actual exit.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      for (const { pid } of children()) {
        try {
          if (alive(pid)) process.kill(pid, "SIGKILL");
        } catch {
          // It exited after the liveness observation.
        }
      }
      await boundedLifecycle(disposing, "teardown after forced cleanup");
      await vi.waitFor(
        () => expect(children().filter(({ pid }) => alive(pid))).toEqual([]),
        poll,
      );
    }
  } finally {
    socketWitnesses.clear();
    rmSync(dir, { recursive: true, force: true });
    for (const key of new Set([
      ...Object.keys(process.env),
      ...Object.keys(savedEnv),
    ])) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

function host(agent: Agent, initial = "before") {
  let id = initial;
  const handlers = new Map<string, Handler>();
  const tools: Tool[] = [];
  const sent: string[] = [];
  const widgets: Array<string[] | undefined> = [];
  const ctx: Context = {
    cwd: dir,
    hasUI: true,
    ui: { setWidget: (_key, lines) => widgets.push(lines) },
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => join(dir, `${id}.jsonl`),
    },
  };
  const api: ExtensionHost = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    sendMessage: ({ content }) => {
      sent.push(content);
    },
    registerTool: (tool) => {
      tools.push(tool);
    },
    registerCommand: () => {},
    arktype: (definition) => definition,
  };
  if (agent === "omp") ompExtension(api);
  else piExtension(api);
  const tool = tools[0];
  if (!tool) throw new Error("watch tool not registered");
  function emit(event: string, nextId = id, payload: unknown = {}) {
    id = nextId;
    const handler = handlers.get(event);
    if (!handler) throw new Error(`missing completed event handler: ${event}`);
    const result = boundedLifecycle(
      Promise.resolve(handler(payload, ctx)),
      `${agent}:${event}`,
    );
    // Race tests intentionally retain concurrent event promises before awaiting
    // them. Keep a timeout rejection observed until that assertion is reached.
    void result.catch(() => {});
    return result;
  }
  const shutdown = () => emit("session_shutdown");
  disposers.push(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
  });
  return {
    ctx,
    sent,
    widgets,
    handlers,
    emit,
    shutdown,
    async run(action = "start", issue = "T-16", context = ctx) {
      const result = await tool.execute(
        "call",
        { action, issue },
        undefined,
        undefined,
        context,
      );
      return result.content[0]?.text ?? "";
    },
  };
}

function channel(agent: Agent): Channel {
  const state =
    process.env[agent === "omp" ? "TODOU_OMP_STATE" : "TODOU_PI_STATE"];
  if (!state) throw new Error("missing state path");
  return { ...JSON.parse(readFileSync(state, "utf8")), state };
}

async function ready(count: number) {
  await vi.waitFor(() => expect(children()).toHaveLength(count), poll);
  return children();
}

async function open(path: string) {
  const socket = connect(path);
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  await once(socket, "connect");
  return socket;
}

const auth = (token: string) => `${JSON.stringify({ type: "auth", token })}\n`;
const frame = (content: string) =>
  JSON.stringify({ type: "user", message: { content } });

async function push(channel: Channel, content: string, token = channel.token) {
  const socket = await open(channel.socket);
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.end(`${auth(token)}${frame(content)}\n`);
  await closed;
}

describe("serialized extension session lifetime", () => {
  it.each(completed)(
    "omp %s reaps the old child, revokes authenticated sockets and starts one fresh watch",
    async (event) => {
      const omp = host("omp");
      await omp.emit("session_start");
      const old = channel("omp");
      expect(await omp.run()).toMatch(/^started w1/);
      const [child] = await ready(1);
      if (!child) throw new Error("missing child");
      const socket = await open(old.socket);
      socket.write(`${auth(old.token)}${frame("before")}\n`);
      await vi.waitFor(() => expect(omp.sent).toEqual(["before"]), poll);
      // A second, idle authenticated connection has no pending bytes that can
      // trigger the generation guard. Only explicit disposal can close it.
      const idleSocket = await open(old.socket);
      socketWitnesses.set(socket, "old authenticated partial-frame connection");
      socketWitnesses.set(idleSocket, "old authenticated idle connection");
      idleSocket.write(`${auth(old.token)}${frame("idle authenticated")}\n`);
      await vi.waitFor(
        () => expect(omp.sent).toEqual(["before", "idle authenticated"]),
        poll,
      );
      const idleClosed = new Promise<void>((resolve) =>
        idleSocket.once("close", resolve),
      );
      socket.write(frame("stale partial frame"));
      const closed = new Promise<void>((resolve) =>
        socket.once("close", resolve),
      );
      await omp.emit(event, "after", { sessionId: "misleading-payload-id" });
      // Observe child lifetime before awaiting close: missing reconciliation
      // must fail on its live PID, rather than hang on an untouched socket.
      witness(event, old);
      expect(alive(child.pid)).toBe(false);
      await boundedLifecycle(
        Promise.all([closed, idleClosed]).then(() => {}),
        `${event}:old authenticated socket closure`,
      );
      expect(socket.destroyed).toBe(true);
      expect(idleSocket.destroyed).toBe(true);
      expect(omp.widgets.at(-1)).toBeUndefined();
      expect(await omp.run("list")).toContain("no watches");
      const current = channel("omp");
      expect(current.session_id).toBe("after");
      expect(current.token).not.toBe(old.token);
      await push(current, "old token", old.token);
      await push(current, "new token");
      expect(omp.sent).toEqual(["before", "idle authenticated", "new token"]);
      const starts = await Promise.all([omp.run(), omp.run()]);
      expect(starts.filter((text) => text.startsWith("started "))).toHaveLength(
        1,
      );
      expect(
        starts.filter((text) => text.includes("already following")),
      ).toHaveLength(1);
      await ready(2);
      witness(`${event}:fresh`, current);
      expect(children().filter(({ pid }) => alive(pid))).toHaveLength(1);
      const fresh = children().find(({ pid }) => pid !== child.pid);
      expect(fresh).toMatchObject({ session: "after", token: current.token });
      expect(omp.widgets.at(-1)).toEqual(["todou watch - T-16"]);
    },
  );

  it.each(completed)(
    "omp %s keeps the same actual session despite event metadata",
    async (event) => {
      const omp = host("omp");
      await omp.emit("session_start");
      expect(await omp.run()).toMatch(/^started/);
      const [child] = await ready(1);
      const old = channel("omp");
      await omp.emit(event, "before", {
        sessionId: "another-session",
        reason: "switch",
      });
      // No-op and cancelled before-events never own cleanup.
      for (const before of [
        "session_before_switch",
        "session_before_branch",
        "session_before_tree",
      ]) {
        await omp.handlers.get(before)?.({ cancel: true }, omp.ctx);
      }
      await omp.emit("agent_start");
      witness(`${event}:same`, old);
      expect(children().filter(({ pid }) => alive(pid))).toEqual([child]);
      expect(channel("omp").token).toBe(old.token);
      expect(await omp.run()).toContain("w1 is already following");
      expect(omp.widgets.at(-1)).toEqual(["todou watch - T-16"]);
      expect(omp.sent).toEqual([]);
    },
  );

  it.each(["omp", "pi"] as const)(
    "%s keeps escalation alive, closes peers first and serializes starts behind cleanup",
    async (agent) => {
      // Real child signal handlers and Unix socket close events cannot be driven
      // by parent fake timers; wait for their observations rather than sleeping.
      process.env.TODOU_TEST_IGNORE_TERM = "1";
      process.env.TODOU_WATCH_START_GRACE_MS = "3000";
      const extension = host(agent);
      await extension.emit("session_start");
      const old = channel(agent);
      const starting = extension.run();
      const [child] = await ready(1);
      if (!child) throw new Error("missing child");
      const socket = await open(old.socket);
      socket.write(`${auth(old.token)}${frame("authenticated")}\n`);
      await vi.waitFor(
        () => expect(extension.sent).toEqual(["authenticated"]),
        poll,
      );
      socket.write(frame("stale"));
      const closed = new Promise<void>((resolve) =>
        socket.once("close", resolve),
      );
      const transition = extension.emit(
        agent === "omp" ? "session_branch" : "session_start",
        "after",
      );
      // An old caller keeps the old identity even though its manager object is
      // mutable; admission must snapshot before waiting for the cleanup queue.
      let staleId = "before";
      const staleContext = {
        ...extension.ctx,
        sessionManager: { getSessionId: () => staleId },
      };
      const staleStart = extension.run("start", "T-18", staleContext);
      staleId = "after";
      const unidentifiedStart = extension.run("start", "T-19", { cwd: dir });
      const freshStarts = [extension.run(), extension.run()];
      await closed;
      witness(`${agent}:socket-closed-before-exit`, old);
      expect(alive(child.pid)).toBe(true);
      expect(children()).toHaveLength(1);
      expect(channel(agent).session_id).toBe("before");
      await transition;
      witness(`${agent}:escalated`, old);
      expect(alive(child.pid)).toBe(false);
      expect(await starting).toContain("session changed");
      expect(await staleStart).toContain("session changed");
      expect(await unidentifiedStart).toContain("session changed");
      const starts = await Promise.all(freshStarts);
      expect(starts.filter((text) => text.startsWith("started "))).toHaveLength(
        1,
      );
      expect(
        starts.filter((text) => text.includes("already following")),
      ).toHaveLength(1);
      await ready(2);
      expect(children().filter(({ pid }) => alive(pid))).toHaveLength(1);
      expect(extension.sent).toEqual(["authenticated"]);
      expect(extension.widgets.at(-1)).toEqual(["todou watch - T-16"]);
    },
    15000,
  );

  it.each(["omp", "pi"] as const)(
    "%s can await repeated shutdowns and immediately restart the same factory",
    async (agent) => {
      const extension = host(agent);
      await extension.emit("session_start");
      const old = channel(agent);
      await extension.run();
      const [child] = await ready(1);
      if (!child) throw new Error("missing child");
      const shuttingDown = extension.shutdown();
      const again = extension.shutdown();
      const blockedStart = extension.run();
      await Promise.all([shuttingDown, again]);
      witness(`${agent}:shutdown`, old);
      expect(alive(child.pid)).toBe(false);
      expect(existsSync(old.state)).toBe(false);
      expect(existsSync(old.socket)).toBe(false);
      expect(await blockedStart).toContain("session is closing");
      expect(await extension.run("list")).toContain("no watches");
      expect(extension.widgets.at(-1)).toBeUndefined();
      const finalShutdown = extension.shutdown();
      const restart = extension.emit("session_start", "after");
      const fresh = extension.run();
      await Promise.all([finalShutdown, restart]);
      expect(await fresh).toMatch(/^started/);
      expect(channel(agent).token).not.toBe(old.token);
      expect(channel(agent).session_id).toBe("after");
      expect(extension.sent).toEqual([]);
    },
  );

  it.each(["omp", "pi"] as const)(
    "%s silently reaps every owned watch at a boundary",
    async (agent) => {
      const extension = host(agent);
      await extension.emit("session_start");
      await Promise.all(
        ["T-16", "T-17", "T-18", "T-19"].map((issue) =>
          extension.run("start", issue),
        ),
      );
      const previous = await ready(4);
      await extension.emit(
        agent === "omp" ? "session_switch" : "session_start",
        "after",
      );
      witness(`${agent}:all-owned-children`, channel(agent));
      expect(previous.filter(({ pid }) => alive(pid))).toEqual([]);
      expect(await extension.run("list")).toContain("no watches");
      expect(extension.widgets.at(-1)).toBeUndefined();
      expect(extension.sent).toEqual([]);
    },
  );

  it.each(["omp", "pi"] as const)(
    "%s ignores unavailable identity and preserves an ordinary turn",
    async (agent) => {
      const extension = host(agent);
      await extension.emit("session_start");
      await extension.run();
      const before = await ready(1);
      const original = channel(agent);
      await extension.handlers.get("agent_start")?.(
        {},
        {
          ...extension.ctx,
          sessionManager: { getSessionId: () => undefined },
        },
      );
      await extension.emit("agent_start");
      witness(`${agent}:ordinary-turn`, original);
      expect(children().filter(({ pid }) => alive(pid))).toEqual(before);
      expect(channel(agent).token).toBe(original.token);
      expect(await extension.run()).toContain("already following");
      expect(extension.sent).toEqual([]);
    },
  );

  it("Pi replaces a runtime even when its session id has not changed", async () => {
    const pi = host("pi");
    await pi.emit("session_start");
    const old = channel("pi");
    await pi.run();
    const [child] = await ready(1);
    if (!child) throw new Error("missing child");
    await pi.emit("session_start");
    witness("pi:same-id-replacement", old);
    expect(alive(child.pid)).toBe(false);
    expect(channel("pi").session_id).toBe("before");
    expect(channel("pi").token).not.toBe(old.token);
    expect(await pi.run("list")).toContain("no watches");
    expect(pi.widgets.at(-1)).toBeUndefined();
    expect(pi.sent).toEqual([]);
    expect(await pi.run()).toMatch(/^started/);
    expect(await pi.run()).toContain("already following");
  });

  it("serializes completed transitions using the identity observed before awaiting", async () => {
    process.env.TODOU_TEST_IGNORE_TERM = "1";
    const omp = host("omp");
    await omp.emit("session_start");
    await omp.run();
    await ready(1);
    const middle = omp.emit("session_switch", "middle");
    const middleStart = omp.run();
    const after = omp.emit("session_tree", "after");
    const finalStart = omp.run();
    await Promise.all([middle, after]);
    expect(await middleStart).toContain("session changed");
    expect(await finalStart).toMatch(/^started/);
    witness("consecutive-transitions", channel("omp"));
    expect(channel("omp").session_id).toBe("after");
    expect(children().filter(({ pid }) => alive(pid))).toHaveLength(1);
    expect(omp.sent).toEqual([]);
  }, 15000);

  it("a subagent cleans its own watches without revoking the root channel", async () => {
    const root = host("omp", "root");
    await root.emit("session_start");
    const original = channel("omp");
    await root.run();
    await ready(1);
    const subagent = host("omp", "subagent");
    await subagent.emit("session_start");
    await subagent.run();
    const before = await ready(2);
    await subagent.emit("session_branch", "subagent-next");
    await subagent.shutdown();
    await subagent.shutdown();
    witness("subagent-disposal", original);
    expect(channel("omp")).toEqual(original);
    expect(before.filter(({ pid }) => alive(pid))).toHaveLength(1);
    expect(await root.run()).toContain("w1 is already following");
    expect(await subagent.run("list")).toContain("no watches");
    await push(original, "root still reachable");
    expect(root.sent).toEqual(["root still reachable"]);
    expect(subagent.sent).toEqual([]);
  });
});
