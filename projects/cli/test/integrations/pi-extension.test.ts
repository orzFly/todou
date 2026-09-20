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
import type { Socket } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_EXTENSION_SOURCE } from "../../src/integrations/pi/extension.generated.ts";
import piExtension from "../../src/integrations/pi/extension.ts";

type Host = Parameters<typeof piExtension>[0];
type Handler = Parameters<Host["on"]>[1];
type Context = Parameters<Handler>[1];
type Tool = Parameters<Host["registerTool"]>[0];
type Command = Parameters<Host["registerCommand"]>[1];

let savedEnv: NodeJS.ProcessEnv;
let dir: string;
const shutdowns: Array<() => Promise<void>> = [];
const sockets = new Set<Socket>();
const poll = { timeout: 5000, interval: 20 };

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "todou-pi-"));
  mkdirSync(join(dir, "pids"));
  mkdirSync(join(dir, "children"));
  mkdirSync(join(dir, "cwd"));
  process.env.XDG_RUNTIME_DIR = dir;
  process.env.TODOU_WATCH_START_GRACE_MS = "150";
  for (const key of [
    "TODOU_PI_STATE",
    "TODOU_PI_TOOLS",
    "TODOU_MESSAGING_SOCKET",
    "TODOU_MESSAGING_TOKEN",
  ]) {
    delete process.env[key];
  }
  // Like the omp fixtures, use a real executable and retain every child pid
  // for teardown even if an assertion fails before the tool returns.
  const child = join(dir, "child.mjs");
  writeFileSync(
    child,
    `import { writeFileSync } from "node:fs";
const keys = ${JSON.stringify([
      "PI_CODING_AGENT",
      "OMPCODE",
      "CLAUDECODE",
      "TODOU_PI_STATE",
      "TODOU_PI_TOOLS",
      "TODOU_OMP_STATE",
      "TODOU_OMP_TOOLS",
      "TODOU_MESSAGING_SOCKET",
      "TODOU_MESSAGING_TOKEN",
    ])};
process.on("SIGTERM", () => process.exit(0));
// Keep the fixture alive until a real signal; parent fake timers cannot drive it.
setInterval(() => {}, 60000);
writeFileSync(${JSON.stringify(join(dir, "children"))} + "/" + process.pid, JSON.stringify({
  cwd: process.cwd(), argv: process.argv.slice(2),
  env: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null])),
}));
`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const bin = join(dir, "todou");
  writeFileSync(
    bin,
    `#!/bin/sh\necho $$ > ${quote(join(dir, "pids"))}/$$\nexec ${quote(process.execPath)} ${quote(child)} "$@"\n`,
    { mode: 0o755 },
  );
  process.env.TODOU_BIN = bin;
});

function livePids(): number[] {
  return readdirSync(join(dir, "pids"))
    .map(Number)
    .filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
}

async function gone() {
  await vi.waitFor(() => expect(livePids()).toEqual([]), poll);
  // Let child close callbacks drain before asserting that no extra push landed.
  await setImmediate();
}

afterEach(async () => {
  try {
    for (const shutdown of shutdowns.splice(0).reverse()) await shutdown();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const pid of livePids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The extension may have reaped it between the liveness check and kill.
      }
    }
    await gone();
  } finally {
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

function host(factory = piExtension) {
  const handlers = new Map<string, Handler[]>();
  const tools: Tool[] = [];
  const commands = new Map<string, Command>();
  const sent: Parameters<Host["sendMessage"]>[] = [];
  const widgets: Array<[string, string[] | undefined]> = [];
  const ctx: Context = {
    hasUI: true,
    ui: { setWidget: (key, lines) => widgets.push([key, lines]) },
  };
  // Deliberately no arktype: this is Pi's native registration surface.
  factory({
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool) => tools.push(tool),
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: (...args) => sent.push(args),
  });
  expect(tools).toHaveLength(1);
  const tool = tools[0];
  if (tool === undefined) throw new Error("todou_watch was not registered");
  async function emit(event: string, context = ctx) {
    expect(handlers.get(event)?.length).toBeGreaterThan(0);
    for (const handler of handlers.get(event) ?? []) await handler({}, context);
  }
  const shutdown = () => emit("session_shutdown");
  shutdowns.push(shutdown);
  return {
    tool,
    commands,
    sent,
    widgets,
    shutdown,
    start(id = "pi-session") {
      return emit("session_start", {
        ...ctx,
        sessionManager: {
          getSessionId: () => id,
          getSessionFile: () => join(dir, `${id}.jsonl`),
        },
      });
    },
    async run(args: unknown) {
      // A cwd only in argument five catches an omp-style context signature.
      const result = await tool.execute(
        "call",
        args,
        new AbortController().signal,
        () => {},
        { cwd: join(dir, "cwd") },
      );
      expect(result.content).toEqual([
        { type: "text", text: expect.any(String) },
      ]);
      const content = result.content[0];
      if (content === undefined) throw new Error("tool returned no content");
      return content.text;
    },
  };
}

function address(sessionId = "pi-session") {
  const state = process.env.TODOU_PI_STATE;
  const socket = process.env.TODOU_MESSAGING_SOCKET;
  const token = process.env.TODOU_MESSAGING_TOKEN;
  expect(state).toBeDefined();
  expect(socket).toBeDefined();
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  if (state === undefined || socket === undefined || token === undefined) {
    throw new Error("the Pi extension did not publish its channel");
  }
  const record = JSON.parse(readFileSync(state, "utf8"));
  expect(record).toEqual({
    v: 1,
    pid: process.pid,
    agent: "pi",
    session_id: sessionId,
    session_file: join(dir, `${sessionId}.jsonl`),
    socket,
    token,
    tools: ["todou_watch"],
    updated_at: expect.any(String),
  });
  expect(Number.isFinite(Date.parse(record.updated_at))).toBe(true);
  expect(process.env.TODOU_PI_TOOLS).toBe("todou_watch");
  expect(existsSync(socket)).toBe(true);
  return { state, socket, token };
}

const frame = (content: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content } });
const auth = (token: string) => JSON.stringify({ type: "auth", token });
const delivery = (content: unknown) => [
  { customType: "todou", content, display: true },
  { deliverAs: "steer", triggerTurn: true },
];

async function open(path: string) {
  const socket = connect(path);
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  await once(socket, "connect");
  return socket;
}

async function exchange(path: string, frames: string[]) {
  const socket = await open(path);
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.end(`${frames.join("\n")}\n`);
  await closed;
}

async function readyChildren(count: number) {
  await vi.waitFor(() => {
    expect(readdirSync(join(dir, "children"))).toHaveLength(count);
    for (const name of readdirSync(join(dir, "children"))) {
      expect(
        JSON.parse(readFileSync(join(dir, "children", name), "utf8")),
      ).toHaveProperty("cwd");
    }
    expect(livePids()).toHaveLength(count);
  }, poll);
}

describe("native Pi extension", () => {
  it("loads the standalone asset without arktype and executes its JSON Schema tool", async () => {
    // A relative import cannot resolve from a data URL. Execute the exported
    // factory and its tool too: merely importing/registering hid past failures.
    const url = `data:text/javascript;base64,${Buffer.from(PI_EXTENSION_SOURCE).toString("base64")}`;
    const bundled = await import(/* @vite-ignore */ url);
    expect(bundled.default).toBeTypeOf("function");
    const pi = host(bundled.default);
    expect(pi.tool.name).toBe("todou_watch");
    const schema = pi.tool.parameters as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: string; enum?: string[] }>;
    };
    expect(Object.getPrototypeOf(schema)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(schema).toMatchObject({
      type: "object",
      required: ["action"],
      additionalProperties: false,
    });
    expect(Object.keys(schema.properties).sort()).toEqual([
      "action",
      "debounce",
      "id",
      "issue",
      "project",
      "server",
      "since",
    ]);
    const action = schema.properties.action;
    if (action === undefined) throw new Error("schema has no action property");
    expect(action.enum).toEqual(["start", "stop", "list"]);
    for (const property of Object.values(schema.properties)) {
      expect(property.type).toBe("string");
    }
    // An inherited omp/Claude environment must not win in the spawned Pi CLI.
    Object.assign(process.env, {
      OMPCODE: "1",
      CLAUDECODE: "1",
      PI_CODING_AGENT: "false",
      TODOU_OMP_STATE: join(dir, "parent.json"),
      TODOU_OMP_TOOLS: "omp-tool",
    });
    await pi.start();
    const channel = address();
    expect(await pi.run({ action: "list" })).toContain("no watches");
    expect(
      await pi.run({
        action: "start",
        issue: "T-16",
        project: "proj",
        server: "https://todou.example",
        since: "c1",
        debounce: "0",
      }),
    ).toMatch(/^started w1 — /);
    await readyChildren(1);
    const [pid] = livePids();
    expect(
      JSON.parse(readFileSync(join(dir, "children", String(pid)), "utf8")),
    ).toEqual({
      cwd: join(dir, "cwd"),
      argv: [
        "issue",
        "watch",
        "T-16",
        "--follow=uds",
        "-p",
        "proj",
        "--server",
        "https://todou.example",
        "--since",
        "c1",
        "--debounce",
        "0",
      ],
      env: {
        PI_CODING_AGENT: "true",
        OMPCODE: null,
        CLAUDECODE: null,
        TODOU_OMP_STATE: null,
        TODOU_OMP_TOOLS: null,
        TODOU_PI_STATE: channel.state,
        TODOU_PI_TOOLS: "todou_watch",
        TODOU_MESSAGING_SOCKET: channel.socket,
        TODOU_MESSAGING_TOKEN: channel.token,
      },
    });
    expect(await pi.run({ action: "list" })).toMatch(/w1\s+T-16\s+running/);
    expect(pi.widgets.at(-1)).toEqual(["todou", ["todou watch - T-16"]]);
    expect(await pi.run({ action: "stop", id: "w1" })).toMatch(/^stopped w1/);
    await gone();
    await vi.waitFor(async () => {
      expect(await pi.run({ action: "list" })).toMatch(/w1\s+T-16\s+exited/);
      expect(pi.widgets.at(-1)).toEqual(["todou", undefined]);
    }, poll);
    expect(pi.sent).toEqual([]);
  });

  it("claims a same-PID inherited record and authenticates native message delivery", async () => {
    const inherited = join(dir, `${process.pid}.json`);
    writeFileSync(
      inherited,
      JSON.stringify({ pid: process.pid, agent: "pi", session_id: "stale" }),
    );
    process.env.TODOU_PI_STATE = inherited;
    process.env.TODOU_MESSAGING_TOKEN = "stale-token";
    const pi = host();
    await pi.start();
    const channel = address();
    expect(channel.state).not.toBe(inherited);
    await exchange(channel.socket, [frame("unauthenticated")]);
    await exchange(channel.socket, [auth("wrong-token"), frame("wrong token")]);
    expect(pi.sent).toEqual([]);
    await exchange(channel.socket, [
      auth(channel.token),
      frame("authenticated batch"),
    ]);
    expect(pi.sent).toEqual([delivery("authenticated batch")]);
  });

  it("/todou stop delivers one native notification for the entire stopped group", async () => {
    const pi = host();
    await pi.start();
    for (const issue of ["T-16", "T-17", "T-18", "T-19"]) {
      expect(await pi.run({ action: "start", issue })).toMatch(/^started w\d/);
    }
    await readyChildren(4);
    const command = pi.commands.get("todou");
    expect(command?.handler).toBeTypeOf("function");
    if (command === undefined) throw new Error("/todou was not registered");
    await command.handler("stop", {});
    await gone();
    await vi.waitFor(() => expect(pi.sent).toHaveLength(1), poll);
    expect(pi.sent).toEqual([
      delivery(expect.stringContaining("The user stopped 4 todou watch(es)")),
    ]);
    const notification = pi.sent[0];
    if (notification === undefined)
      throw new Error("stop sent no notification");
    for (const id of ["w1", "w2", "w3", "w4"]) {
      expect(notification[0].content).toContain(id);
    }
    expect(pi.widgets.at(-1)).toEqual(["todou", undefined]);
    await command.handler("stop", {});
    await setImmediate();
    expect(pi.sent).toHaveLength(1);
  });

  it.each(["same factory", "fresh factory", "reload"] as const)(
    "%s can reclaim the same PID after closing watches and old sockets",
    async (mode) => {
      const first = host();
      await first.start("before");
      const old = address("before");
      expect(await first.run({ action: "start", issue: "T-16" })).toMatch(
        /^started w1/,
      );
      await readyChildren(1);
      const socket = await open(old.socket);
      socket.write(`${auth(old.token)}\n${frame("before shutdown")}\n`);
      await vi.waitFor(
        () => expect(first.sent).toEqual([delivery("before shutdown")]),
        poll,
      );
      socket.write(frame("must not arrive"));
      const closed = new Promise<void>((resolve) =>
        socket.once("close", resolve),
      );
      let next = first;
      if (mode === "reload") {
        await first.start("after");
      } else {
        await first.shutdown();
        expect(existsSync(old.state)).toBe(false);
        expect(existsSync(old.socket)).toBe(false);
        for (const key of [
          "TODOU_PI_STATE",
          "TODOU_PI_TOOLS",
          "TODOU_MESSAGING_SOCKET",
          "TODOU_MESSAGING_TOKEN",
        ]) {
          expect(process.env[key]).toBeUndefined();
        }
        await expect(open(old.socket)).rejects.toMatchObject({
          code: expect.stringMatching(/ENOENT|ECONNREFUSED/),
        });
      }
      socket.end("\n");
      await closed;
      await gone();
      expect(first.sent).toEqual([delivery("before shutdown")]);
      expect(first.widgets.at(-1)).toEqual(["todou", undefined]);
      if (mode !== "reload") {
        if (mode === "fresh factory") next = host();
        await next.start("after");
      }
      const current = address("after");
      expect(current.state).toBe(old.state);
      expect(current.socket).toBe(old.socket);
      expect(current.token).not.toBe(old.token);
      expect(await next.run({ action: "list" })).toContain("no watches");
      const baseline = next.sent.length;
      await exchange(current.socket, [
        auth(old.token),
        frame("stale credentials"),
      ]);
      expect(next.sent).toHaveLength(baseline);
      await exchange(current.socket, [
        auth(current.token),
        frame("after restart"),
      ]);
      expect(next.sent.slice(baseline)).toEqual([delivery("after restart")]);
      expect(await next.run({ action: "start", issue: "T-16" })).toMatch(
        /^started w\d+ — /,
      );
      await vi.waitFor(() => expect(livePids()).toHaveLength(1), poll);
      await next.shutdown();
      await gone();
      expect(existsSync(current.state)).toBe(false);
      expect(existsSync(current.socket)).toBe(false);
      expect(next.sent.slice(baseline)).toEqual([delivery("after restart")]);
    },
    15000,
  );
});
