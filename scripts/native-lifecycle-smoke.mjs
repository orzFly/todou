#!/usr/bin/env node
/**
 * No-model native lifecycle smoke. Run from any directory:
 *   node scripts/native-lifecycle-smoke.mjs --scratch .tmp/native-lifecycle
 *   node scripts/native-lifecycle-smoke.mjs --host omp --routes branch --asset source
 *   node scripts/native-lifecycle-smoke.mjs --host pi --routes import --asset-file .tmp/mutant.ts
 *
 * --host both|omp|pi (both); --asset generated|source (generated)
 * --omp-bin PATH / --pi-bin PATH (omp / pi); --python PATH (python3)
 * --routes comma-separated route names; --timeout MS (30000)
 * --scratch DIR retains report, terminal/event logs and loaded asset on success
 * and failure. Without it all scratch files are removed after printing report.
 *
 * Source mode bundles the current source with esbuild into scratch; generated
 * mode extracts the checked-in string without regenerating it. --asset-file
 * takes a standalone loaded TS/JS payload and requires one --host. Mutations
 * therefore identify exactly which bytes ran. No model/provider requests are
 * required. The real registered watch tool runs a signal-responsive fixture;
 * CLI lifetime-guard/server tests are intentionally a separate suite.
 *
 * Native commands: /new, omp /fork, pi /import, pi /reload, omp /restart,
 * /todou stop. Shared native API dispatch: switchSession (resume), branch
 * (/branch and /rewind selector target), pi fork/clone, navigateTree. turn is
 * explicitly wrapper-dispatched agent_start, not a native model turn. noop is
 * an ordinary probe; same-session resume is a distinct route. No silent skips.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "scripts/fixtures/native-lifecycle");
const options = {
  host: "both",
  asset: "generated",
  timeout: "30000",
  "omp-bin": "omp",
  "pi-bin": "pi",
  python: "python3",
};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  if (key === "help" || key === "h") {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("*/")[0]
        .replace(/^#!.*\n\/\*\*\n/, "")
        .replace(/^ \* ?/gm, ""),
    );
    process.exit(0);
  }
  if (
    ![
      "host",
      "asset",
      "asset-file",
      "scratch",
      "timeout",
      "routes",
      "omp-bin",
      "pi-bin",
      "python",
    ].includes(key) ||
    !process.argv[i + 1]
  )
    throw new Error(`Unknown/missing option: ${process.argv[i]}`);
  options[key] = process.argv[++i];
}
assert(
  ["both", "pi", "omp"].includes(options.host),
  "--host must be both, pi or omp",
);
assert(
  ["source", "generated"].includes(options.asset),
  "--asset must be source or generated",
);
assert(
  !options["asset-file"] || options.host !== "both",
  "--asset-file requires one host",
);
const timeout = Number(options.timeout);
assert(
  Number.isFinite(timeout) && timeout >= 1000,
  "--timeout must be >=1000ms",
);
const matrices = {
  omp: [
    "new",
    "resume",
    "fork",
    "branch",
    "rewind",
    "tree",
    "turn",
    "noop",
    "same-resume",
    "restart",
    "stop",
  ],
  pi: [
    "new",
    "resume",
    "fork",
    "clone",
    "import",
    "tree",
    "turn",
    "noop",
    "same-resume",
    "reload",
    "stop",
    "nested",
  ],
};
const hosts = options.host === "both" ? ["omp", "pi"] : [options.host];
const selected = options.routes?.split(",");
if (selected)
  for (const route of selected)
    assert(
      hosts.some((host) => matrices[host].includes(route)),
      `Unknown route: ${route}`,
    );
mkdirSync(options.scratch ? resolve(options.scratch) : join(root, ".tmp"), {
  recursive: true,
});
const scratch = mkdtempSync(
  join(
    options.scratch ? resolve(options.scratch) : join(root, ".tmp"),
    "native-",
  ),
);
// Unix sockaddr paths are short even when caller scratch is a deep worktree.
const runtime = mkdtempSync(join(tmpdir(), "td-native-"));
chmodSync(runtime, 0o700);
const report = {
  startedAt: new Date().toISOString(),
  scratch,
  assetMode: options["asset-file"] ? "asset-file" : options.asset,
  status: "running",
  hosts: [],
  routes: [],
  limitations: [
    "No model calls: turn dispatches captured agent_start reconciliation hooks; it is not a native provider turn.",
    "branch/rewind and pi fork/clone use the native command-context API; interactive selector keystrokes are not covered.",
    "sendMessage is captured rather than forwarded, preventing watch stop/push notifications from starting a model turn.",
    "The child is a real watch-process fixture; CLI lifetime-guard and fixture-server behavior belong to the separate real-process suite.",
    "Pi /import is an additional native resume shutdown/start matrix row; no lifecycle design change.",
  ],
};
const owned = [];
const sockets = new Set();
let interrupted;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = signal;
  });
function save() {
  writeFileSync(
    join(scratch, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
function records(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function pidState(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error.code === "ESRCH") return "ESRCH";
    throw error;
  }
}
async function waitFor(label, condition, host, duration = timeout) {
  const deadline = Date.now() + duration;
  while (true) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    const value = await condition();
    if (value) return value;
    if (host?.exited)
      throw new Error(
        `${label}: PTY exited (${host.exited.code}); see ${host.terminal}`,
      );
    if (host) {
      const error = records(host.events).find(
        (e) => e.kind === "unexpected-model-turn",
      );
      if (error)
        throw new Error("Unexpected native model turn; see events.jsonl");
    }
    if (Date.now() >= deadline) throw new Error(`Timeout waiting for ${label}`);
    // Poll interval, not a scenario sleep: every advance requires a condition.
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
function text(result) {
  return result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
}
function send(host, command) {
  appendFileSync(
    host.commands,
    `${JSON.stringify({ at: new Date().toISOString(), command })}\n`,
  );
  // Clear prompt restored by fork/tree before submitting another slash command.
  host.child.stdin.write(`${JSON.stringify({ input: `\x15${command}\r` })}\n`);
}

async function waitForPrompt(host) {
  // session_start precedes omp's bootstrap submit gate and setup wizard.
  // A harmless command acknowledgement proves the actual composer dispatches.
  // Retry only until the command begins; no lifecycle mutation is retried.
  const id = randomUUID();
  let sentAt = 0;
  await waitFor(
    `${host.name} interactive command readiness`,
    () => {
      const rows = records(host.events).filter((event) => event.id === id);
      const error = rows.find((event) => event.kind === "probe-error");
      if (error) throw new Error(`Readiness probe failed: ${error.error}`);
      if (rows.some((event) => event.kind === "probe-done")) return true;
      const terminal = readFileSync(host.terminal, "utf8");
      if (
        /Setup.*Step\\s*1|Welcome to setup|press enter to skip/i.test(terminal)
      ) {
        throw new Error(
          `Unexpected onboarding overlay in ${host.terminal}; isolated setupVersion was not honored`,
        );
      }
      if (
        !rows.some((event) => event.kind === "probe-begin") &&
        Date.now() - sentAt >= 250
      ) {
        send(host, `/probe ${JSON.stringify({ op: "noop", id })}`);
        sentAt = Date.now();
      }
      return false;
    },
    host,
  );
}
async function probe(host, op, args = {}) {
  const id = randomUUID();
  send(host, `/probe ${JSON.stringify({ op, id, ...args })}`);
  const row = await waitFor(
    `probe ${op}`,
    () =>
      records(host.events).find(
        (e) => e.id === id && ["probe-done", "probe-error"].includes(e.kind),
      ),
    host,
  );
  if (row.kind === "probe-error") throw new Error(`${op}: ${row.error}`);
  return row.value;
}
async function snapshot(host) {
  return probe(host, "snapshot");
}
async function startWatch(host) {
  const result = await probe(host, "start");
  const match = text(result).match(/pid (\d+)/);
  assert(match, `watch did not start: ${text(result)}`);
  const pid = Number(match[1]);
  const child = await waitFor(
    "watch child start record",
    () =>
      records(host.children).find(
        (e) => e.kind === "child-start" && e.pid === pid,
      ),
    host,
  );
  assert.equal(pidState(pid), "alive");
  return { pid, result, child };
}
async function connectSocket(path) {
  const socket = createConnection(path);
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  await new Promise((resolveConnect, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Socket connect timeout: ${path}`));
    }, timeout);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolveConnect();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}
async function authenticated(host, state, marker) {
  const socket = await connectSocket(state.socket);
  const cursor = records(host.events).length;
  socket.write(
    `${JSON.stringify({ type: "auth", token: state.token })}\n${JSON.stringify({ type: "user", message: { content: marker } })}\n`,
  );
  await waitFor(
    "authenticated socket delivery",
    () =>
      records(host.events)
        .slice(cursor)
        .find((e) => e.kind === "delivery" && e.message.content === marker),
    host,
  );
  return socket;
}
async function prepareAsset(host, dir) {
  const source = join(
    root,
    `projects/cli/src/integrations/${host}/extension.ts`,
  );
  const generated = source.replace(/\.ts$/, ".generated.ts");
  let payload;
  if (options["asset-file"])
    payload = readFileSync(resolve(options["asset-file"]), "utf8");
  else if (options.asset === "source") {
    const { build } = await import("esbuild");
    const built = await build({
      absWorkingDir: root,
      entryPoints: [source],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["node:*"],
      write: false,
      legalComments: "none",
    });
    payload = built.outputFiles[0].text;
  } else {
    const module = readFileSync(generated, "utf8");
    const match = module.match(/export const \w+\s*=\s*("(?:[^"\\]|\\.)*");/s);
    assert(match, `Cannot extract generated payload from ${generated}`);
    payload = JSON.parse(match[1]);
  }
  const asset = join(dir, "asset.ts");
  writeFileSync(asset, payload);
  return {
    asset,
    loadedSha256: createHash("sha256").update(payload).digest("hex"),
    sourceSha256: createHash("sha256")
      .update(readFileSync(source))
      .digest("hex"),
    generatedSha256: createHash("sha256")
      .update(readFileSync(generated))
      .digest("hex"),
  };
}
async function launch(name) {
  const dir = join(scratch, name);
  for (const part of [
    "",
    "home",
    "agent",
    "sessions",
    "project",
    "config",
    "cache",
  ])
    mkdirSync(join(dir, part), { recursive: true });
  const assets = await prepareAsset(name, dir);
  copyFileSync(join(fixture, "wrapper.mjs"), join(dir, "wrapper.ts"));
  copyFileSync(join(fixture, "watch-child.mjs"), join(dir, "watch-child.mjs"));
  chmodSync(join(dir, "watch-child.mjs"), 0o700);
  const host = {
    name,
    dir,
    ...assets,
    events: join(dir, "events.jsonl"),
    children: join(dir, "children.jsonl"),
    terminal: join(dir, "terminal.log"),
    commands: join(dir, "commands.jsonl"),
    runId: randomUUID(),
    exited: null,
  };
  owned.push(host);
  for (const path of [host.events, host.children, host.terminal, host.commands])
    writeFileSync(path, "");
  const configPath = join(dir, "probe.json");
  writeFileSync(
    configPath,
    JSON.stringify({ host: name, asset: assets.asset, events: host.events }),
  );
  // A local HTTP tripwire proves no provider call was made, including host
  // automatic naming paths not routed through extension before_agent_start.
  host.providerCalls = [];
  const http = await import("node:http");
  host.provider = http.createServer((req, res) => {
    host.providerCalls.push({ url: req.url, method: req.method });
    res.writeHead(503);
    res.end("native lifecycle smoke forbids model calls");
  });
  await new Promise((resolveListen) =>
    host.provider.listen(0, "127.0.0.1", resolveListen),
  );
  const models = {
    providers: {
      smoke: {
        baseUrl: `http://127.0.0.1:${host.provider.address().port}/v1`,
        api: "openai-completions",
        apiKey: "smoke-not-a-secret",
        models: [
          {
            id: "local",
            name: "Local lifecycle fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  // JSON is also valid YAML; do not copy any installed credentials/config.
  writeFileSync(
    join(dir, "agent", name === "pi" ? "models.json" : "models.yml"),
    JSON.stringify(models),
  );
  writeFileSync(
    join(dir, "agent", name === "pi" ? "settings.json" : "config.yml"),
    JSON.stringify({
      defaultProvider: "smoke",
      defaultModel: "local",
      defaultThinkingLevel: "off",
      quietStartup: true,
      // omp v18.2.5 CURRENT_SETUP_VERSION=2; without this the wizard opens
      // after session_start and consumes probe text as provider search input.
      ...(name === "omp"
        ? {
            setupVersion: 2,
            startup: {
              quiet: true,
              showSplash: false,
              checkUpdate: false,
              changelogMode: "hidden",
            },
          }
        : {}),
      sessionNaming: { enabled: false },
    }),
  );
  const env = {
    ...process.env,
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_DATA_HOME: join(dir, "home", "data"),
    XDG_RUNTIME_DIR: runtime,
    PI_CONFIG_DIR: join(dir, "config"),
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_NO_TITLE: "1",
    TERM: "xterm-256color",
    SHELL: "/bin/sh",
    TODOU_BIN: join(dir, "watch-child.mjs"),
    TODOU_WATCH_START_GRACE_MS: "30",
    TODOU_SMOKE_CONFIG: configPath,
    TODOU_SMOKE_CHILD_LOG: host.children,
    TODOU_SMOKE_RUN_ID: host.runId,
  };
  for (const key of Object.keys(env))
    if (
      /^(TODOU_(OMP|PI|MESSAGING)|OMPCODE$|CLAUDECODE$|OMP_PROFILE$|PI_PROFILE$|RN_.*PRESET|OPENAI_|ANTHROPIC_)/.test(
        key,
      )
    )
      delete env[key];
  const binary = options[`${name}-bin`];
  host.version = execFileSync(binary, ["--version"], {
    env,
    encoding: "utf8",
    timeout,
  }).trim();
  const args = [
    "--no-extensions",
    "-e",
    join(dir, "wrapper.ts"),
    "--session-dir",
    join(dir, "sessions"),
    "--provider",
    "smoke",
    "--model",
    "local",
    "--thinking",
    "off",
  ];
  host.child = spawn(
    options.python,
    [join(fixture, "terminal-driver.py"), binary, ...args],
    { env, cwd: join(dir, "project"), stdio: ["pipe", "pipe", "pipe"] },
  );
  host.child.on("error", (error) => {
    host.exited = { code: String(error) };
  });
  host.child.on("exit", (code, signal) => {
    host.exited ??= { code, signal };
  });
  host.child.stderr.on("data", (chunk) => appendFileSync(host.terminal, chunk));
  const lines = createInterface({ input: host.child.stdout });
  lines.on("line", (line) => {
    try {
      const row = JSON.parse(line);
      if (row.kind === "spawn") host.pid = row.pid;
      if (row.kind === "output")
        appendFileSync(host.terminal, Buffer.from(row.base64, "base64"));
      if (row.kind === "exit") host.exited = row;
    } catch (error) {
      host.exited = { code: `PTY protocol: ${error}` };
    }
  });
  if (name === "pi") {
    await waitFor(
      "pi project trust or startup",
      () =>
        records(host.events).some(
          (e) => e.kind === "native-event" && e.event === "session_start",
        ) ||
        readFileSync(host.terminal, "utf8").includes("Trust project folder?"),
      host,
    );
    if (
      !records(host.events).some(
        (e) => e.kind === "native-event" && e.event === "session_start",
      )
    ) {
      host.child.stdin.write(
        `${JSON.stringify({ input: "\x1b[B\x1b[B\r" })}\n`,
      );
    }
  }
  await waitFor(
    `${name} session_start`,
    () =>
      records(host.events).find(
        (e) => e.kind === "native-event" && e.event === "session_start",
      ),
    host,
  );
  const loaded = records(host.events).find((e) => e.kind === "loaded");
  assert.equal(loaded.assetSha256, assets.loadedSha256);
  await waitForPrompt(host);
  report.hosts.push({
    name,
    binary,
    version: host.version,
    ...assets,
    terminal: host.terminal,
    events: host.events,
  });
  save();
  return host;
}

async function runRoute(host, route) {
  const row = {
    host: host.name,
    route,
    status: "running",
    assetSha256: host.loadedSha256,
  };
  report.routes.push(row);
  save();
  // Every route starts from an independently persisted native session with an
  // assistant entry. Native /new must not discard the resume/fork fixture.
  const seedOffset = records(host.events).length;
  await probe(host, "seed");
  const seed = records(host.events)
    .slice(seedOffset)
    .find((e) => e.kind === "seeded");
  assert(
    seed && existsSync(seed.sessionFile),
    "Saved assistant fixture missing",
  );
  const saved = join(host.dir, `saved-${route}.jsonl`);
  copyFileSync(seed.sessionFile, saved);
  if (route === "resume" || route === "import") await probe(host, "new");
  const oldWatch = await startWatch(host);
  const before = await snapshot(host);
  assert(
    before.state?.token && before.state.socket,
    "No published credentials",
  );
  const held = await authenticated(
    host,
    before.state,
    `before:${route}:${randomUUID()}`,
  );
  row.before = {
    ...before,
    child: oldWatch.child,
    oldPid: oldWatch.pid,
    oldPidState: pidState(oldWatch.pid),
  };
  save(); // Mutation evidence exists even if a transition fails or times out.
  const offset = records(host.events).length;
  const changes =
    !["tree", "turn", "noop", "nested"].includes(route) &&
    !(route === "same-resume" && host.name === "omp") &&
    route !== "stop";
  try {
    if (
      ["new", "restart", "reload"].includes(route) ||
      (route === "fork" && host.name === "omp")
    ) {
      row.dispatch = "native-command";
      send(host, `/${route}`);
      await waitFor(
        `native /${route} completion`,
        () =>
          records(host.events)
            .slice(offset)
            .find(
              (e) =>
                e.kind === "native-event" &&
                (route === "fork"
                  ? e.event === "session_switch" && e.reason === "fork"
                  : route === "new"
                    ? (e.event === "session_switch" ||
                        e.event === "session_start") &&
                      e.reason === "new"
                    : e.event === "session_start"),
            ),
        host,
      );
      if (route === "restart" || route === "reload") await waitForPrompt(host);
    } else if (route === "import") {
      row.dispatch = "native-command";
      send(host, `/import ${saved}`);
      await waitFor(
        "native import confirmation",
        () =>
          readFileSync(host.terminal, "utf8").includes(
            `Replace current session with ${saved}?`,
          ),
        host,
      );
      host.child.stdin.write(`${JSON.stringify({ input: "\r" })}\n`);
      await waitFor(
        "native /import resume",
        () =>
          records(host.events)
            .slice(offset)
            .find(
              (e) =>
                e.kind === "native-event" &&
                e.event === "session_start" &&
                e.reason === "resume",
            ),
        host,
      );
    } else if (route === "nested") {
      row.dispatch = "nested-native-pi-rpc-bash";
      row.result = await probe(host, "nested", {
        binary: options["pi-bin"],
        node: process.execPath,
        cli: join(root, "projects/cli/src/index.ts"),
      });
      assert.equal(row.result.success, true, "Nested bash command failed");
      assert.match(
        JSON.stringify(row.result),
        /no pi session above this process has published/,
      );
    } else if (route === "stop") {
      row.dispatch = "native-command";
      send(host, "/todou");
      await waitFor(
        "/todou list UI",
        () =>
          records(host.events)
            .slice(offset)
            .find(
              (e) =>
                e.kind === "notify" &&
                e.command === "todou" &&
                /watch|following/.test(e.text),
            ),
        host,
      );
      send(host, "/todou stop");
      await waitFor(
        "/todou stop completion",
        () =>
          records(host.events)
            .slice(offset)
            .find(
              (e) =>
                e.kind === "extension-command-done" && e.command === "todou",
            ),
        host,
      );
    } else {
      row.dispatch =
        route === "turn"
          ? "wrapper-dispatch:agent_start"
          : route === "noop"
            ? "probe-noop"
            : "native-command-context-api";
      row.aliases =
        route === "rewind" || route === "branch"
          ? ["/branch", "/rewind", "ctx.branch"]
          : undefined;
      await probe(
        host,
        route === "resume" || route === "same-resume" ? "switch" : route,
        route === "resume"
          ? { path: saved }
          : route === "same-resume"
            ? { path: before.sessionFile }
            : {},
      );
    }
    row.events = records(host.events)
      .slice(offset)
      .filter((e) => ["native-event", "dispatched-event"].includes(e.kind));
    const after = await snapshot(host);
    // Observe PID/socket state before acceptance assertions. For mutants these
    // remain alive/open, which is the evidence, not just a failing assertion.
    if (changes || route === "stop") {
      try {
        await waitFor(
          "old child ESRCH",
          () => pidState(oldWatch.pid) === "ESRCH",
          host,
          Math.min(timeout, 5000),
        );
      } catch (error) {
        row.observationTimeout = String(error);
      }
    }
    row.after = {
      ...after,
      oldPidState: pidState(oldWatch.pid),
      oldSocketClosed: held.destroyed,
    };
    save();
    assert.equal(
      host.providerCalls.length,
      0,
      `Unexpected provider calls: ${JSON.stringify(host.providerCalls)}`,
    );
    assert.equal(
      after.state?.session_id,
      after.sessionId,
      "Published session identity is stale",
    );
    if (changes) {
      assert.equal(
        row.after.oldPidState,
        "ESRCH",
        `${route}: old watch survived`,
      );
      assert(held.destroyed, `${route}: old authenticated socket survived`);
      assert.notEqual(
        after.state.token,
        before.state.token,
        `${route}: credentials did not rotate`,
      );
      if (!["reload", "restart", "same-resume"].includes(route))
        assert.notEqual(
          after.sessionId,
          before.sessionId,
          `${route}: session id did not change`,
        );
      const badAuth = await connectSocket(after.state.socket);
      badAuth.write(
        `${JSON.stringify({ type: "auth", token: before.state.token })}\n`,
      );
      await waitFor("old credentials refused", () => badAuth.destroyed, host);
      row.oldCredentialsRefused = true;
      assert.match(
        text(await probe(host, "list")),
        /no watches|0 watches|nothing/i,
        "New session retained old watch records",
      );
      const fresh = await startWatch(host);
      const count = records(host.children).filter(
        (e) => e.kind === "child-start",
      ).length;
      const dedupe = await probe(host, "start");
      row.fresh = { pid: fresh.pid, child: fresh.child, dedupe: text(dedupe) };
      save();
      assert.notEqual(fresh.pid, oldWatch.pid);
      assert.equal(fresh.child.token, after.state.token);
      assert.equal(fresh.child.state.session_id, after.sessionId);
      assert.match(text(dedupe), /already following/);
      assert(text(dedupe).includes(`pid ${fresh.pid}`));
      assert.equal(
        records(host.children).filter((e) => e.kind === "child-start").length,
        count,
        "Deduplication spawned another child",
      );
      const newSocket = await authenticated(
        host,
        after.state,
        `after:${route}:${randomUUID()}`,
      );
      newSocket.destroy();
    } else if (route === "stop") {
      assert.equal(
        row.after.oldPidState,
        "ESRCH",
        "/todou stop left child alive",
      );
      assert.equal(
        after.state.token,
        before.state.token,
        "stop rotated session credentials",
      );
      assert(!held.destroyed, "stop closed session socket");
      await waitFor(
        "stop notification captured",
        () =>
          records(host.events)
            .slice(offset)
            .find((e) => e.kind === "delivery"),
        host,
      );
      await waitFor(
        "stop widget cleared",
        () =>
          records(host.events)
            .slice(offset)
            .find(
              (e) =>
                e.kind === "widget" && e.name === "todou" && e.lines === null,
            ),
        host,
      );
    } else {
      assert.equal(
        row.after.oldPidState,
        "alive",
        `${route}: same-session watch died`,
      );
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(after.state.token, before.state.token);
      assert(!held.destroyed, `${route}: same-session socket closed`);
      assert(text(await probe(host, "start")).includes(`pid ${oldWatch.pid}`));
    }
    row.status = "passed";
  } catch (error) {
    row.status = "failed";
    row.error = String(error);
    row.events = records(host.events)
      .slice(offset)
      .filter((e) => ["native-event", "dispatched-event"].includes(e.kind));
    row.failureObservation = {
      oldPid: oldWatch.pid,
      oldPidState: pidState(oldWatch.pid),
      oldSocketClosed: held.destroyed,
    };
    throw error;
  } finally {
    held.destroy();
    save();
  }
}

async function cleanup() {
  for (const socket of sockets) socket.destroy();
  for (const host of owned) {
    host.child?.stdin.end(`${JSON.stringify({ stop: true })}\n`);
    if (host.child && !host.exited) {
      try {
        await waitFor("PTY cleanup", () => host.exited, null, 5000);
      } catch {
        host.child.kill("SIGKILL");
      }
    }
    // Fixture PID records are owned by this run, never discovered by process
    // name. Signal only a PID still bearing the unique run marker in /proc.
    for (const child of records(host.children).filter(
      (e) => e.kind === "child-start",
    )) {
      try {
        const env = readFileSync(`/proc/${child.pid}/environ`, "utf8");
        if (env.split("\0").includes(`TODOU_SMOKE_RUN_ID=${host.runId}`))
          process.kill(child.pid, "SIGKILL");
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code))
          report.cleanupError = String(error);
      }
    }
    if (host.pid && pidState(host.pid) === "alive") {
      try {
        const env = readFileSync(`/proc/${host.pid}/environ`, "utf8");
        if (env.split("\0").includes(`TODOU_SMOKE_RUN_ID=${host.runId}`))
          process.kill(-host.pid, "SIGKILL");
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code))
          report.cleanupError = String(error);
      }
    }
    host.provider?.closeAllConnections();
    if (host.provider)
      await new Promise((resolveClose) => host.provider.close(resolveClose));
    const hostReport = report.hosts.find((h) => h.name === host.name);
    if (hostReport) hostReport.providerRequests = host.providerCalls;
    if (host.providerCalls?.length) {
      report.status = "failed";
      report.error ??= "Unexpected provider requests";
      process.exitCode = 1;
    }
    // Keep caller-requested reports/logs/asset, remove runtime state and sessions.
    for (const part of [
      "home",
      "agent",
      "sessions",
      "project",
      "config",
      "cache",
    ])
      rmSync(join(host.dir, part), { recursive: true, force: true });
  }
  rmSync(runtime, { recursive: true, force: true });
}
try {
  for (const name of hosts) {
    const host = await launch(name);
    for (const route of matrices[name].filter(
      (route) => !selected || selected.includes(route),
    )) {
      console.log(`${name}: ${route}`);
      await runRoute(host, route);
    }
    const exitWatch = await startWatch(host);
    const exitState = await snapshot(host);
    const exitRow = {
      host: name,
      route: "exit",
      dispatch: "native-command",
      oldPid: exitWatch.pid,
      before: pidState(exitWatch.pid),
      assetSha256: host.loadedSha256,
    };
    report.routes.push(exitRow);
    save();
    send(host, "/quit");
    await waitFor("native host exit", () => host.exited, null);
    exitRow.after = {
      oldPidState: pidState(exitWatch.pid),
      manifestExists: existsSync(exitState.statePath),
      socketExists: existsSync(exitState.state.socket),
      exit: host.exited,
    };
    save();
    assert.equal(
      exitRow.after.oldPidState,
      "ESRCH",
      "Native exit left watch child alive",
    );
    assert.equal(
      exitRow.after.manifestExists,
      false,
      "Native exit left manifest",
    );
    assert.equal(exitRow.after.socketExists, false, "Native exit left socket");
    assert.equal(host.exited.code, 0, "Native host exited unsuccessfully");
    exitRow.status = "passed";
    save();
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    report.status = "failed";
    report.cleanupError = String(error);
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify(report, null, 2));
  if (options.scratch) console.log(`Report: ${join(scratch, "report.json")}`);
  else rmSync(scratch, { recursive: true, force: true });
}
