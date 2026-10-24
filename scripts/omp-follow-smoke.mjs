#!/usr/bin/env node
/**
 * Does what `todou agent can-i-follow` tells an omp agent to do, inside a real
 * interactive omp, and checks that a comment on the card then wakes the agent
 * (T-564). Run from any directory:
 *   node scripts/omp-follow-smoke.mjs
 *   node scripts/omp-follow-smoke.mjs --only tool --keep
 *   node scripts/omp-follow-smoke.mjs --cli /path/to/projects/cli/src/index.ts
 *   node scripts/omp-follow-smoke.mjs --omp-bin /path/to/omp
 *
 * Three checks, each a fresh omp session with a scripted stand-in for the
 * model. "Woken" means the main agent was sent a request carrying the
 * comment; omp also hands a running job's output to a side model that draws
 * the job's status line, and that request does not count.
 *
 *   tool     — extension installed: can-i-follow names `xd://todou_watch`,
 *              the tool's own documentation declares `profile`, and a watch
 *              started through it as the account the agent uses wakes it;
 *   batch    — no extension: can-i-follow prescribes a one-batch watch as an
 *              async job, and doing exactly that wakes the agent, twice, the
 *              second time from the cursor the first wake carried;
 *   service  — extension installed: `--follow=uds` from a named bash service
 *              (which omp runs under its daemon broker) wakes the agent.
 *
 * Pushed watches run with `--debounce 0`, so a wake is not 60 seconds of
 * batching late. Every watch runs as a non-default account: the default token belongs to
 * `bot-one`, the project is readable only by `bot-two` under profile `alt`,
 * so a watch that falls back to the default account fails outright.
 *
 * `--cli` points the whole run at another CLI — a checkout of an older
 * revision, say — which is how the checks are seen to fail: the extension is
 * installed by that CLI and every `todou` in the session is that CLI. Needs no
 * model login; the model is a local openai-completions stub. Sockets live
 * under os.tmpdir() (a Unix socket path must fit in 108 bytes); everything
 * else goes to a scratch dir under .tmp/. Both are removed on exit unless
 * --keep.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(root, "projects/server/src/index.ts");
const driver = join(
  root,
  "scripts/fixtures/native-lifecycle/terminal-driver.py",
);

const options = {
  cli: join(root, "projects/cli/src/index.ts"),
  "omp-bin": "omp",
  python: "python3",
  only: "",
  keep: false,
};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  if (key === "keep") options.keep = true;
  else if (key in options) options[key] = process.argv[++i];
  else throw new Error(`unknown option ${process.argv[i]}`);
}
const CHECKS = ["tool", "batch", "service"];
if (options.only && !CHECKS.includes(options.only)) {
  throw new Error(`--only takes one of ${CHECKS.join(", ")}`);
}

mkdirSync(join(root, ".tmp"), { recursive: true });
const scratch = mkdtempSync(join(root, ".tmp", "omp-follow-smoke-"));
const short = mkdtempSync(join(tmpdir(), "todou-of-"));
chmodSync(short, 0o700);
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
  // The server's database can still be flushing when this runs; retry.
  const gone = { recursive: true, force: true, maxRetries: 5 };
  rmSync(short, gone);
  if (!options.keep) rmSync(scratch, gone);
  else console.log(`kept ${scratch}`);
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
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

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
const server = spawn(
  process.execPath,
  [
    serverEntry,
    "serve",
    "--config",
    join(scratch, "server.toml"),
    "--port",
    "0",
  ],
  {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: scratch },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
children.push(server);
let serverOutput = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    serverOutput += chunk;
    log(`[server] ${String(chunk).trimEnd()}`);
  });
}
const serverPort = Number(
  (
    await until(
      "the todou server",
      () => /todou server listening on :(\d+)\b/.exec(serverOutput),
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
const admin = {
  authorization: `Bearer ${
    (
      await api(
        "/api/me/tokens",
        { method: "POST", body: JSON.stringify({ name: "smoke" }) },
        { cookie },
      )
    ).json.token
  }`,
};
const tokens = {};
for (const agentLogin of ["bot-one", "bot-two"]) {
  const agent = (
    await api(
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({ login: agentLogin, display_name: agentLogin }),
      },
      admin,
    )
  ).json;
  tokens[agentLogin] = (
    await api(
      `/api/agents/${agent.id}/tokens`,
      { method: "POST", body: JSON.stringify({ name: "smoke" }) },
      admin,
    )
  ).json.token;
}
await api(
  "/api/projects",
  { method: "POST", body: JSON.stringify({ slug: "smoke", name: "Smoke" }) },
  admin,
);
await api(
  "/api/projects/smoke/members",
  {
    method: "POST",
    body: JSON.stringify({ login: "bot-two", role: "writer" }),
  },
  admin,
);
const issue = (
  await api(
    "/api/projects/smoke/issues",
    { method: "POST", body: JSON.stringify({ title: "follow me" }) },
    admin,
  )
).json.number;
const comment = (body) =>
  api(
    `/api/projects/smoke/issues/${issue}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
    admin,
  );

// --- the model -------------------------------------------------------------

/**
 * Each check installs its own script: a list of replies, each either a value
 * or a function of the newest message, consumed by main-agent requests only.
 */
let script = [];
/** Every request the main agent made, in arrival order. */
let agentRequests = [];
const isAgent = (body) =>
  (body.tools ?? []).some((tool) => tool.function?.name === "bash");
const newest = (body) => JSON.stringify(body.messages.at(-1) ?? {});

const model = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(body);
    const agent = isAgent(parsed);
    if (agent) agentRequests.push(parsed);
    log(`[model ${agent ? "agent" : "side"}] ${newest(parsed).slice(0, 2000)}`);
    let next = agent ? script.shift() : undefined;
    if (typeof next === "function") next = next(newest(parsed));
    next ??= { text: "waiting" };
    const chunk = { id: randomUUID(), object: "chat.completion.chunk" };
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ ...chunk, created: 0, model: "local", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (next.tool) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name: next.tool,
              arguments: JSON.stringify(next.args),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: next.text });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
model.unref();

const bash = (command, extra = {}) => ({
  tool: "bash",
  args: { i: "smoke", command, ...extra },
});

// --- omp -------------------------------------------------------------------

const ompVersion = execFileSync(options["omp-bin"], ["--version"], {
  encoding: "utf8",
}).trim();
say(`omp: ${ompVersion} · cli: ${options.cli}`);

/** A `todou` that is the CLI under test, by absolute path or on PATH. */
const bin = join(scratch, "bin");
mkdirSync(bin);
const todou = join(bin, "todou");
writeFileSync(
  todou,
  options.cli.endsWith(".ts") || options.cli.endsWith(".js")
    ? `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(options.cli))} "$@"\n`
    : `#!/bin/sh\nexec ${JSON.stringify(resolve(options.cli))} "$@"\n`,
);
chmodSync(todou, 0o755);

/** One isolated omp home per check, so an extension never leaks across. */
function home(name, { extension }) {
  const dir = join(scratch, name);
  const project = join(dir, "project");
  for (const part of ["home", "agent", "config/todou", "cache"]) {
    mkdirSync(join(dir, part), { recursive: true });
  }
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir, "home", ".zshrc"), "");
  writeFileSync(join(project, ".todou.toml"), 'project = "smoke"\n');
  writeFileSync(
    join(dir, "config", "todou", "config.toml"),
    [
      `default_server = "${base}"`,
      "",
      `[servers."${base}"]`,
      `token = "${tokens["bot-one"]}"`,
      "",
      `[servers."${base}".tokens]`,
      `alt = "${tokens["bot-two"]}"`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "agent", "models.yml"),
    JSON.stringify({
      providers: {
        smoke: {
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          api: "openai-completions",
          apiKey: "smoke-not-a-secret",
          models: [
            {
              id: "local",
              name: "Local",
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "agent", "config.yml"),
    JSON.stringify({
      defaultProvider: "smoke",
      defaultModel: "local",
      defaultThinkingLevel: "off",
      setupVersion: 2,
      startup: {
        quiet: true,
        showSplash: false,
        checkUpdate: false,
        changelogMode: "hidden",
      },
      sessionNaming: { enabled: false },
    }),
  );
  const runtime = join(short, name);
  mkdirSync(runtime, { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_DATA_HOME: join(dir, "home", "data"),
    XDG_STATE_HOME: join(dir, "home", "state"),
    XDG_RUNTIME_DIR: runtime,
    PI_CONFIG_DIR: join(dir, "config"),
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_NO_TITLE: "1",
    TERM: "xterm-256color",
    SHELL: "/bin/sh",
  };
  for (const key of Object.keys(env)) {
    if (
      /^(TODOU_|OMPCODE$|CLAUDECODE$|CLAUDE_CODE_|OMP_PROFILE$|PI_PROFILE$|RN_)/.test(
        key,
      )
    ) {
      delete env[key];
    }
  }
  if (extension) {
    log(
      execFileSync(todou, ["integration", "install", "omp"], {
        env,
        encoding: "utf8",
      }).trim(),
    );
  }
  return { dir, project, env };
}

/** Starts an interactive omp whose first turn is `go`; resolves once idle. */
async function session(name, where) {
  const terminal = join(scratch, `${name}.terminal.log`);
  const host = spawn(
    options.python,
    [
      driver,
      options["omp-bin"],
      "--no-title",
      "--model",
      "smoke/local",
      "--approval-mode",
      "yolo",
      "--cwd",
      where.project,
      "go",
    ],
    { cwd: where.project, env: where.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(host);
  let pending = "";
  host.stdout.on("data", (chunk) => {
    pending += chunk;
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      const row = JSON.parse(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      if (row.kind === "output") {
        appendFileSync(terminal, Buffer.from(row.base64, "base64"));
      }
    }
  });
  host.stderr.on("data", (chunk) => appendFileSync(terminal, chunk));
  const steps = script.length;
  await until(
    `${name}: the scripted turn to run out`,
    () => agentRequests.length > steps && script.length === 0,
    60_000,
  );
  await sleep(3000);
  return host;
}

async function stop(host) {
  host.stdin.write(`${JSON.stringify({ stop: true })}\n`);
  await Promise.race([
    new Promise((r) => host.once("exit", r)),
    sleep(5000).then(() => host.kill("SIGKILL")),
  ]);
}

/** The tool result the agent was sent for its n-th scripted call. */
const toolResult = (n) => {
  const results = agentRequests
    .map((body) => body.messages.at(-1))
    .filter((message) => message?.role === "tool");
  const content = results[n]?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
};

/** Posts a comment; resolves to the newest-message text of the wake. */
async function wakes(label, timeoutMs = 45_000) {
  const marker = `SMOKE-${label}-${randomUUID()}`;
  const before = agentRequests.length;
  await comment(marker);
  const woke = await until(
    `the agent to be woken by ${label}`,
    () =>
      agentRequests
        .slice(before)
        .find((body) => JSON.stringify(body).includes(marker)),
    timeoutMs,
  );
  return newest(woke);
}

const failures = [];
async function check(name, body) {
  if (options.only && options.only !== name) return;
  script = [];
  agentRequests = [];
  try {
    await body();
    say(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    say(`FAIL ${name}: ${error.message}`);
  }
}

await check("tool", async () => {
  const where = home("tool", { extension: true });
  script = [
    bash("todou agent can-i-follow"),
    { tool: "read", args: { path: "xd://todou_watch" } },
    {
      tool: "write",
      args: {
        path: "xd://todou_watch",
        content: JSON.stringify({
          action: "start",
          issue: String(issue),
          profile: "alt",
          debounce: "0",
        }),
      },
    },
  ];
  const host = await session("tool", where);
  try {
    assert.match(toolResult(0), /xd:\/\/todou_watch/, "can-i-follow");
    assert.match(toolResult(1), /`profile`/, "the tool's documentation");
    assert.match(toolResult(2), /^started w1/, "the tool's start");
    await wakes("tool");
  } finally {
    await stop(host);
  }
});

await check("batch", async () => {
  const where = home("batch", { extension: false });
  const watch = (since) =>
    bash(
      `todou issue watch ${issue} --profile alt${since ? ` --since ${since}` : ""}`,
      { async: true, timeout: 0 },
    );
  script = [bash("todou agent can-i-follow"), watch()];
  const host = await session("batch", where);
  try {
    const advice = toolResult(0);
    // The prescription itself, not words that also occur in a fallback: an
    // async `--follow=stdout` job prints into a status line nobody reads.
    assert.match(
      advice,
      /Run `todou watch` or `todou issue watch` without `--follow`, started with the bash tool's `async: true` and `timeout: 0`/,
      "can-i-follow prescribes the one-batch async watch",
    );
    assert.doesNotMatch(
      advice,
      /try `--follow=stdout`/,
      "can-i-follow offers --follow=stdout",
    );
    // The restart the advice asks for, from the cursor the wake carried.
    script = [
      (message) => {
        const cursor = /cursor: (\S+?)(?:\\n|\s|$)/.exec(message)?.[1];
        assert.ok(cursor, `no cursor in ${message}`);
        return watch(cursor);
      },
    ];
    await wakes("batch-first");
    await sleep(3000);
    await wakes("batch-second");
  } finally {
    await stop(host);
  }
});

await check("service", async () => {
  const where = home("service", { extension: true });
  // By absolute path: a service's PATH is the system default, not omp's.
  script = [
    bash(
      `${todou} issue watch ${issue} --profile alt --follow=uds --debounce 0`,
      {
        name: "todouwatch",
      },
    ),
  ];
  const host = await session("service", where);
  try {
    await wakes("service");
  } finally {
    await stop(host);
  }
});

say(
  failures.length === 0
    ? "all checks passed"
    : `${failures.length} failed: ${failures.join(", ")}`,
);
server.kill("SIGTERM");
await Promise.race([new Promise((r) => server.once("exit", r)), sleep(5000)]);
process.exit(failures.length === 0 ? 0 : 1);
