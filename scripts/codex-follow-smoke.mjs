#!/usr/bin/env node
/**
 * `--follow=codex` against a real Codex app-server and a real todou server,
 * with a scripted stand-in for the model. Run from any directory:
 *   node scripts/codex-follow-smoke.mjs
 *   node scripts/codex-follow-smoke.mjs --codex-bin /path/to/codex --keep
 *   node scripts/codex-follow-smoke.mjs --cli result/bin/todou  # a built CLI
 *   node scripts/codex-follow-smoke.mjs --mutate queue   # must fail
 *   node scripts/codex-follow-smoke.mjs --mutate busy   # must fail
 *
 * Three checks, each against what the model is actually sent:
 *   queue  — no control socket: a comment on the card reaches the idle thread
 *            through `codex queue` as a new turn;
 *   busy   — even with an App socket present, another card's comment waits
 *            for the active turn to finish and survives the watcher exiting;
 *   range  — the second batch's `since:` is the first batch's `cursor:`.
 *
 * `--mutate` breaks one input on purpose so the check guarding it can be seen
 * to fail: `queue` hands the watch a `codex` that confirms nothing, `busy`
 * lets the running turn finish before the comment is posted.
 *
 * The smoke posts as the account the watch runs as, so the watch takes
 * --any-actor; the self-filter is not what this checks.
 *
 * Needs no model login: the app-server talks to a local Responses API stub.
 * Sockets and CODEX_HOME live under os.tmpdir() because a Unix socket path
 * must fit in 108 bytes; everything else goes to a scratch dir under .tmp/.
 * Both are removed on exit unless --keep.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(root, "projects/cli/src/index.ts");
const serverEntry = join(root, "projects/server/src/index.ts");
const WebSocket = createRequire(join(root, "projects/cli/package.json"))("ws");

const options = { "codex-bin": "codex", cli: "", mutate: "", keep: false };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  if (key === "keep") options.keep = true;
  else if (key in options) options[key] = process.argv[++i];
  else throw new Error(`unknown option ${process.argv[i]}`);
}
if (!["", "queue", "busy"].includes(options.mutate)) {
  throw new Error("--mutate takes queue or busy");
}

mkdirSync(join(root, ".tmp"), { recursive: true });
const scratch = mkdtempSync(join(root, ".tmp", "codex-follow-smoke-"));
const short = mkdtempSync(join(tmpdir(), "todou-cf-"));
const codexHome = join(short, "home");
mkdirSync(codexHome);
const appSocket = join(short, "app.sock");
const logFile = join(scratch, "smoke.log");
const children = [];
const log = (line) => {
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
};
const say = (line) => {
  console.log(line);
  log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  rmSync(short, { recursive: true, force: true });
  if (!options.keep) rmSync(scratch, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(130));
}

async function until(what, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"]) {
    child[stream].on("data", (chunk) => {
      child.output[stream] += chunk;
      log(`[${name} ${stream}] ${String(chunk).trimEnd()}`);
    });
  }
  return child;
}

// --- the model -------------------------------------------------------------

/** Every Responses request, as the text of its newest input item. */
const modelRequests = [];
/** Requests whose newest item says SLOW are held until this resolves. */
let releaseSlow = () => {};
let slowGate = Promise.resolve();

const model = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", async () => {
    if (!req.url.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    const input = JSON.parse(body).input ?? [];
    const last = JSON.stringify(input.at(-1) ?? {});
    modelRequests.push(last);
    log(`[model] ${last.slice(0, 300)}`);
    if (last.includes("SLOW")) await slowGate;
    const id = `r${modelRequests.length}`;
    const events = [
      { type: "response.created", response: { id } },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: `m${id}`,
          content: [{ type: "output_text", text: "ok" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id,
          usage: {
            input_tokens: 0,
            input_tokens_details: null,
            output_tokens: 0,
            output_tokens_details: null,
            total_tokens: 0,
          },
        },
      },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const ev of events) {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    res.end();
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const modelPort = model.address().port;
model.unref();

writeFileSync(
  join(codexHome, "config.toml"),
  [
    'model = "smoke-model"',
    'model_provider = "smoke"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "",
    "[model_providers.smoke]",
    'name = "smoke"',
    `base_url = "http://127.0.0.1:${modelPort}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  ].join("\n"),
);

// --- todou -----------------------------------------------------------------

writeFileSync(
  join(scratch, "server.toml"),
  [
    "[auth]",
    'mode = "single"',
    "",
    "[database]",
    `system = "pglite://${join(scratch, "db")}"`,
    "auto_migrate = true",
    "",
    "[storage]",
    'backend = "fs"',
    `path = "${join(scratch, "attachments")}"`,
    "",
  ].join("\n"),
);
const server = start(
  "server",
  process.execPath,
  [
    serverEntry,
    "serve",
    "--config",
    join(scratch, "server.toml"),
    "--port",
    "0",
  ],
  { PATH: process.env.PATH, HOME: scratch },
);
const serverPort = Number(
  (
    await until(
      "the todou server",
      () =>
        /todou server listening on :(\d+)\b/.exec(
          server.output.stdout + server.output.stderr,
        ),
      60_000,
    )
  )[1],
);
const base = `http://127.0.0.1:${serverPort}`;

async function api(path, init = {}, auth = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...auth, ...init.headers },
  });
  const text = await response.text();
  assert.ok(
    response.ok,
    `${init.method ?? "GET"} ${path}: ${response.status} ${text}`,
  );
  return { response, json: text ? JSON.parse(text) : null };
}
const login = await api("/api/auth/login", { method: "POST", body: "{}" });
const cookie = login.response.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const token = (
  await api(
    "/api/me/tokens",
    { method: "POST", body: JSON.stringify({ name: "smoke" }) },
    { cookie },
  )
).json.token;
const bearer = { authorization: `Bearer ${token}` };
await api(
  "/api/projects",
  { method: "POST", body: JSON.stringify({ slug: "smoke", name: "Smoke" }) },
  bearer,
);
const issue = (
  await api(
    "/api/projects/smoke/issues",
    { method: "POST", body: JSON.stringify({ title: "follow me" }) },
    bearer,
  )
).json;
const comment = (body, number = issue.number) =>
  api(
    `/api/projects/smoke/issues/${number}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
    bearer,
  );

// --- codex -----------------------------------------------------------------

const codexBin = execFileSync(
  "sh",
  ["-c", 'command -v "$0"', options["codex-bin"]],
  {
    encoding: "utf8",
  },
).trim();
say(
  `codex: ${execFileSync(codexBin, ["--version"], { encoding: "utf8" }).trim()} at ${codexBin}`,
);
// Observe actual queue admission before stopping the watcher in the busy case.
const queueLog = join(scratch, "queued.jsonl");
writeFileSync(queueLog, "");
const queueBin = join(short, "codex-queue-observed");
writeFileSync(
  queueBin,
  `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(codexBin)}, args, { encoding: 'utf8' });
if (result.status === 0 && result.stdout.startsWith('Queued message '))
  appendFileSync(${JSON.stringify(queueLog)}, JSON.stringify(args) + '\\n');
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`,
);
chmodSync(queueBin, 0o755);
const admitted = (marker) => readFileSync(queueLog, "utf8").includes(marker);
const codexEnv = { PATH: process.env.PATH, HOME: short, CODEX_HOME: codexHome };
start(
  "app-server",
  codexBin,
  ["app-server", "--listen", `unix://${appSocket}`],
  codexEnv,
);
await until(
  "the app-server socket",
  async () => {
    try {
      await new Promise((ok, fail) =>
        connect(appSocket)
          .once("connect", function () {
            this.destroy();
            ok();
          })
          .once("error", fail),
      );
      return true;
    } catch {
      return false;
    }
  },
  30_000,
);

const app = new WebSocket("ws://localhost/", {
  createConnection: () => connect(appSocket),
  perMessageDeflate: false,
});
await new Promise((ok, fail) => app.once("open", ok).once("error", fail));
let rpcId = 0;
const pending = new Map();
/** turn/started and turn/completed per thread, in arrival order. */
const turns = [];
app.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (
    message.method === "turn/started" ||
    message.method === "turn/completed"
  ) {
    turns.push({
      event: message.method,
      thread: message.params.threadId,
      turn: message.params.turn?.id,
    });
  }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const rpc = (method, params) =>
  new Promise((ok) => {
    const id = ++rpcId;
    pending.set(id, ok);
    app.send(JSON.stringify({ id, method, params }));
  }).then((m) => {
    assert.ok(!m.error, `${method}: ${JSON.stringify(m.error)}`);
    return m.result;
  });
await rpc("initialize", { clientInfo: { name: "smoke-app", version: "0" } });
app.send(JSON.stringify({ method: "initialized" }));

async function thread() {
  const id = (await rpc("thread/start", { cwd: scratch })).thread.id;
  // A first turn gives the thread its rollout, which `codex queue` looks up.
  await rpc("turn/start", {
    threadId: id,
    input: [{ type: "text", text: "hello" }],
  });
  await until("the first turn", () => completed(id) >= 1, 30_000);
  return id;
}
const completed = (id) =>
  turns.filter((t) => t.thread === id && t.event === "turn/completed").length;
const started = (id) =>
  turns.filter((t) => t.thread === id && t.event === "turn/started").length;

function watch(threadId, extra) {
  return start(
    `watch ${threadId.slice(-4)}`,
    options.cli ? resolve(options.cli) : process.execPath,
    [
      ...(options.cli ? [] : [cliEntry]),
      "watch",
      "-p",
      "smoke",
      "--follow=codex",
      "--debounce",
      "0",
      "--interval",
      "1",
      "--any-actor",
    ],
    {
      PATH: process.env.PATH,
      HOME: short,
      XDG_CONFIG_HOME: join(scratch, "xdg"),
      XDG_STATE_HOME: join(scratch, "xdg"),
      TODOU_SERVER: base,
      TODOU_TOKEN: token,
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: threadId,
      TODOU_CODEX_BIN: queueBin,
      ...extra,
    },
  );
}
const requestWith = (marker) => modelRequests.find((r) => r.includes(marker));
const failures = [];
async function check(name, body) {
  try {
    await body();
    say(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    say(`FAIL ${name}: ${error.message}`);
  }
}

// queue + range
const queued = await thread();
let queueEnv = {};
if (options.mutate === "queue") {
  const fake = join(short, "codex-silent");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  chmodSync(fake, 0o755);
  queueEnv = { TODOU_CODEX_BIN: fake };
}
const queueWatch = watch(queued, queueEnv);
await check("watch opens over codex queue", () =>
  until(
    "the via line",
    () => queueWatch.output.stderr.includes("via codex queue"),
    30_000,
  ),
);
const first = `SMOKE-QUEUE-${randomUUID()}`;
await comment(first);
await check(
  "queue: the comment reaches the idle thread as a new turn",
  async () => {
    await until(
      "the model to see the first comment",
      () => requestWith(first),
      45_000,
    );
    await until(
      "a second turn on the thread",
      () => completed(queued) >= 2,
      30_000,
    );
  },
);
const second = `SMOKE-RANGE-${randomUUID()}`;
await comment(second);
await check(
  "range: the second batch starts where the first ended",
  async () => {
    const a = await until("the first batch", () => requestWith(first), 1_000);
    const b = await until(
      "the second batch",
      () => requestWith(second),
      45_000,
    );
    const cursor = /cursor: ([^\\\s]+)/.exec(
      JSON.parse(a).content?.[0]?.text ?? a,
    )?.[1];
    const since = /since: ([^\\\s]+)/.exec(
      JSON.parse(b).content?.[0]?.text ?? b,
    )?.[1];
    assert.ok(cursor, "first batch carries a cursor");
    assert.equal(since, cursor);
  },
);
queueWatch.kill("SIGTERM");

// An App-connected thread busy on one card must process another card later.
const busy = await thread();
const other = (
  await api(
    "/api/projects/smoke/issues",
    {
      method: "POST",
      body: JSON.stringify({ title: "another card needs revision" }),
    },
    bearer,
  )
).json;
const busyWatch = watch(busy, { TODOU_CODEX_SOCKET: appSocket });
await check("App watch also opens over codex queue", () =>
  until(
    "the via line",
    () => busyWatch.output.stderr.includes("via codex queue"),
    30_000,
  ),
);
slowGate = new Promise((r) => {
  releaseSlow = r;
});
const current = await rpc("turn/start", {
  threadId: busy,
  input: [{ type: "text", text: "SLOW work on the first card" }],
});
await until(
  "the slow request to reach the model",
  () => requestWith("SLOW"),
  10_000,
);
if (options.mutate === "busy") {
  releaseSlow();
  await until("the slow turn to end", () => completed(busy) >= 2, 10_000);
}
const third = `SMOKE-BUSY-${randomUUID()}`;
await comment(third, other.number);
await check(
  "busy: another card waits, then starts a new turn after watch exit",
  async () => {
    await until(
      "the batch to be durably queued",
      () => admitted(third),
      30_000,
    );
    // Exercise at least one queue polling interval while the turn is held.
    await sleep(12_000);
    assert.equal(completed(busy), 1, "the original turn must still be busy");
    assert.equal(
      started(busy),
      2,
      "the batch must not start a concurrent turn",
    );
    assert.equal(
      requestWith(third),
      undefined,
      "the batch must not steer current work",
    );
    busyWatch.kill("SIGTERM");
    await until(
      "the watcher to stop",
      () => busyWatch.exitCode !== null || busyWatch.signalCode !== null,
      10_000,
    );
    releaseSlow();
    await until(
      "the queued batch to finish",
      () => completed(busy) >= 3,
      45_000,
    );
    assert.ok(
      requestWith(third),
      "the model receives the other card after watch exit",
    );
    const lifecycle = turns.filter((t) => t.thread === busy);
    const finished = lifecycle.findIndex(
      (t) => t.event === "turn/completed" && t.turn === current.turn.id,
    );
    assert.ok(finished >= 0);
    assert.equal(lifecycle[finished + 1]?.event, "turn/started");
    assert.notEqual(lifecycle[finished + 1]?.turn, current.turn.id);
    assert.equal(
      started(busy),
      3,
      "exactly one new turn handles the queued batch",
    );
  },
);
releaseSlow();
busyWatch.kill("SIGTERM");

say(failures.length === 0 ? "PASS" : `FAILED: ${failures.join("; ")}`);
if (options.keep) say(`scratch kept at ${scratch}`);
process.exit(failures.length === 0 ? 0 : 1);
