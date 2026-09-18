/** Isolated stack and cross-worktree lock for the manual browser smokes.
 * After changing scripts/lib/, run `pnpm test:browser --self-test-cdp`
 * and all three browser self-tests listed in `pnpm test:browser --help`.
 * None run in CI.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 90_000;
const LOG_LIMIT = 8_000;
const LOCK_READY = "todou-browser-lock-ready";

const RESOURCE_SAMPLE_MS = 250;
export function sanitizedEnvironment(overrides = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("TODOU_")) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

function commandOutput(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function sourceVersion(root) {
  try {
    return commandOutput("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: root,
    });
  } catch {
    return "unknown";
  }
}

function gitCommonDirectory(root) {
  const common = commandOutput(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root },
  );
  const absolute = isAbsolute(common) ? common : resolve(root, common);
  if (!isAbsolute(absolute))
    throw new Error("git common directory is not absolute");
  return absolute;
}

function chromiumVersion(chromium) {
  if (chromium.includes(sep)) accessSync(chromium, constants.X_OK);
  return commandOutput(chromium, ["--version"]);
}

function checkDependencies(root, chromium) {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(
      `needs Node 24 (the server entry is TypeScript); this is ${process.version}. ` +
        "Use the devshell's node.",
    );
  }

  commandOutput("flock", ["--version"]);
  const commonDir = gitCommonDirectory(root);
  const serverEntry = resolve(root, "projects/server/src/index.ts");
  const viteBin = resolve(root, "projects/web/node_modules/vite/bin/vite.js");
  for (const dependency of [serverEntry, viteBin]) {
    if (!existsSync(dependency)) {
      throw new Error(`missing browser-smoke dependency: ${dependency}`);
    }
  }

  return {
    commonDir,
    chromium: chromiumVersion(chromium),
    node: process.version,
    source: sourceVersion(root),
    serverEntry,
    viteBin,
  };
}

function validatePort(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${label} must be an integer from 0 through 65535`);
  }
}

function processGroupExists(child) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function signalGroup(child, signal) {
  if (!child) return;
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroup(child, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (processGroupExists(child) && Date.now() < deadline) {
    await sleep(50);
  }
  return !processGroupExists(child);
}

export async function stopProcessGroup(child, graceMs = 5_000) {
  if (!child) return;
  if (!child.pid) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return;
  }
  if (!processGroupExists(child)) return;
  signalGroup(child, "SIGTERM");
  if (await waitForProcessGroup(child, graceMs)) return;
  signalGroup(child, "SIGKILL");
  if (!(await waitForProcessGroup(child, 1_000))) {
    throw new Error(`process group ${child.pid} survived SIGKILL`);
  }
}

class ProcessTreeResources {
  #roots = new Set();
  #timer;

  constructor() {
    this.summary = {
      peakRssKiB: 0,
      sampleIntervalMs: RESOURCE_SAMPLE_MS,
      samples: 0,
      limitation:
        "summed RSS double-counts shared pages; processes shorter than the sample interval may be missed",
    };
    this.#timer = setInterval(() => this.sample(), RESOURCE_SAMPLE_MS);
    this.#timer.unref?.();
  }

  add(pid) {
    if (pid) this.#roots.add(pid);
    this.sample();
  }

  sample() {
    const processes = new Map();
    try {
      for (const entry of readdirSync("/proc", { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const pid = Number(entry.name);
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
          const parent = Number(fields[1]);
          const status = readFileSync(`/proc/${pid}/status`, "utf8");
          const rss = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
          processes.set(pid, { parent, rss });
        } catch {}
      }
    } catch {
      return;
    }

    const owned = new Set([...this.#roots].filter((pid) => processes.has(pid)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, processInfo] of processes) {
        if (!owned.has(pid) && owned.has(processInfo.parent)) {
          owned.add(pid);
          changed = true;
        }
      }
    }
    const rss = [...owned].reduce(
      (total, pid) => total + (processes.get(pid)?.rss ?? 0),
      0,
    );
    this.summary.samples++;
    this.summary.peakRssKiB = Math.max(this.summary.peakRssKiB, rss);
  }

  stop() {
    clearInterval(this.#timer);
    this.sample();
  }
}

class BrowserStackLifecycle {
  #children = [];
  #cleanupPromise = null;
  #finalizers = [];
  #resourceSampler = new ProcessTreeResources();
  #signalHandlers = new Map();
  #stopping = false;

  constructor({ root, name, dir, tmpRoot, keep, versions, startedAt }) {
    this.root = root;
    this.name = name;
    this.dir = dir;
    this.tmpRoot = tmpRoot;
    this.keep = keep;
    this.versions = versions;
    this.startedAt = startedAt;
    this.timings = {};
    this.resources = this.#resourceSampler.summary;
  }

  spawn(command, args, options, label) {
    const child = spawn(command, args, {
      detached: true,
      ...options,
    });
    this.registerChild(child, label);
    return child;
  }

  registerChild = (child, label = "child") => {
    const record = { child, label, tail: "" };
    this.#resourceSampler.add(child.pid);
    this.#children.push(record);

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => {
        record.tail = (record.tail + chunk.toString("utf8")).slice(-LOG_LIMIT);
      });
    }
    child.on("error", (error) => {
      record.tail = `${record.tail}\nspawn error: ${error.message}`.slice(
        -LOG_LIMIT,
      );
    });
    child.on("exit", (code, signal) => {
      if (!this.#stopping && code !== null && code !== 0) {
        console.error(
          `${label} exited ${code}${signal ? ` (${signal})` : ""}\n${record.tail}`,
        );
      }
    });
    return async () => await stopProcessGroup(child);
  };

  tail(child) {
    return this.#children.find((record) => record.child === child)?.tail ?? "";
  }

  addCleanup(finalizer) {
    this.#finalizers.push(finalizer);
    return () => {
      const index = this.#finalizers.indexOf(finalizer);
      if (index !== -1) this.#finalizers.splice(index, 1);
    };
  }

  async stop(child) {
    await stopProcessGroup(child);
  }

  installSignalHandlers() {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ]) {
      const handler = () => {
        void this.cleanup().finally(() => process.exit(code));
      };
      this.#signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  #removeSignalHandlers() {
    for (const [signal, handler] of this.#signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.#signalHandlers.clear();
  }

  cleanup() {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = this.#cleanup();
    return this.#cleanupPromise;
  }

  async #cleanup() {
    const cleanupStartedAt = Date.now();
    this.#stopping = true;
    this.#removeSignalHandlers();
    const errors = [];

    for (const finalizer of [...this.#finalizers].reverse()) {
      try {
        await finalizer();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#finalizers.length = 0;

    for (const { child } of [...this.#children].reverse()) {
      try {
        await stopProcessGroup(child);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#resourceSampler.stop();
    if (errors.length > 0 && !this.keep) {
      this.keep = {
        remove: ["attachments", "chrome", "db"],
        message: `kept cleanup diagnostics: ${this.dir}`,
      };
    }

    try {
      this.#cleanArtifacts();
    } catch (error) {
      errors.push(error);
    }

    this.timings.cleanupMs = Date.now() - cleanupStartedAt;
    this.timings.totalMs = Date.now() - this.startedAt;
    if (this.keep && this.dir) {
      try {
        this.#writeLog();
      } catch (error) {
        errors.push(error);
      }
    }
    const activeResources = process.getActiveResourcesInfo?.() ?? [];
    console.log(
      `STACK timings=${JSON.stringify(this.timings)} ` +
        `peakRssKiB=${this.resources.peakRssKiB} samples=${this.resources.samples} ` +
        `sampleIntervalMs=${this.resources.sampleIntervalMs} rssNote=${JSON.stringify(this.resources.limitation)} ` +
        `activeResources=${activeResources.join(",") || "none"}`,
    );
    if (errors.length > 0)
      throw new AggregateError(errors, "stack cleanup failed");
  }

  #cleanArtifacts() {
    if (!this.dir) return;
    const withinTmp =
      this.dir.startsWith(`${this.tmpRoot}${sep}`) &&
      relative(this.tmpRoot, this.dir) !== "";
    if (!withinTmp)
      throw new Error(`refusing to clean unsafe path: ${this.dir}`);

    if (!this.keep) {
      rmSync(this.dir, { recursive: true, force: true });
      return;
    }
    if (typeof this.keep === "object") {
      for (const name of this.keep.remove ?? []) {
        if (name !== basename(name) || name === "." || name === "..") {
          throw new Error(`unsafe kept-artifact entry: ${name}`);
        }
        rmSync(join(this.dir, name), { recursive: true, force: true });
      }
      console.log(this.keep.message ?? `kept ${this.dir}`);
      return;
    }
    console.log(`kept ${this.dir}`);
  }

  #writeLog() {
    writeFileSync(
      join(this.dir, "browser-stack.log"),
      [
        `versions=${JSON.stringify(this.versions)}`,
        `timings=${JSON.stringify(this.timings)}`,
        `resources=${JSON.stringify(this.resources)}`,
        ...this.#children.map(
          ({ label, tail }) => `\n[${label}]\n${tail || "(no output)"}`,
        ),
        "",
      ].join("\n"),
    );
  }
}

async function waitForLog(lifecycle, child, label, pattern, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const tail = lifecycle.tail(child);
    pattern.lastIndex = 0;
    const match = pattern.exec(tail);
    if (match) return match;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before readiness\n${tail}`);
    }
    await sleep(100);
  }
  throw new Error(
    `${label} did not emit its readiness log in ${budgetMs}ms\n${lifecycle.tail(child)}`,
  );
}

async function waitForHttp(
  lifecycle,
  child,
  url,
  label,
  validate,
  budgetMs = DEFAULT_TIMEOUT_MS,
) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${label} exited before readiness at ${url}\n${lifecycle.tail(child)}`,
      );
    }
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetch(url, {
        signal: AbortSignal.timeout(remainingMs),
      });
      if (response.ok && (await validate(response))) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(
    `${label} did not return expected content at ${url} in ${budgetMs}ms\n${lifecycle.tail(child)}`,
  );
}

async function acquireLock(lifecycle, commonDir) {
  const lockPath = resolve(commonDir, "todou-browser-smoke.lock");
  const lockProgram =
    `process.stdout.write(${JSON.stringify(`${LOCK_READY}\n`)});` +
    "process.stdin.resume();";
  const child = lifecycle.spawn(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      "--no-fork",
      lockPath,
      process.execPath,
      "-e",
      lockProgram,
    ],
    {
      cwd: lifecycle.root,
      env: sanitizedEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
    "browser-smoke lock",
  );
  try {
    await waitForLog(
      lifecycle,
      child,
      "browser-smoke lock",
      new RegExp(`^${LOCK_READY}$`, "m"),
      10_000,
    );
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `another browser smoke holds the nonblocking lock ${lockPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  return lockPath;
}

function writeServerConfig(dir, serverPort) {
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    [
      "[auth]",
      'mode = "single"',
      "",
      "[http]",
      ...(serverPort ? [`port = ${serverPort}`] : []),
      "",
      "[database]",
      `system = "pglite://${join(dir, "db")}"`,
      "auto_migrate = true",
      "",
      "[database.projects]",
      'placement = "shared"',
      "",
      "[storage]",
      'backend = "fs"',
      `path = "${join(dir, "attachments")}"`,
      "",
    ].join("\n"),
  );
  return config;
}

export async function createBrowserStack({
  root,
  prefix,
  name = prefix,
  chromium = process.env.CHROMIUM ?? "/usr/bin/chromium",
  serverPort = 0,
  webPort = 0,
  webReadyPath = "/",
  keep = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const startedAt = Date.now();
  const dependencyStartedAt = Date.now();
  const absoluteRoot = resolve(root);
  validatePort(serverPort, "server port");
  validatePort(webPort, "web port");
  const versions = checkDependencies(absoluteRoot, chromium);
  const dependenciesMs = Date.now() - dependencyStartedAt;
  const tmpRoot = resolve(absoluteRoot, ".tmp");
  const lifecycle = new BrowserStackLifecycle({
    root: absoluteRoot,
    name,
    dir: null,
    tmpRoot,
    keep,
    versions,
    startedAt,
  });
  lifecycle.timings.dependenciesMs = dependenciesMs;

  try {
    const lockStartedAt = Date.now();
    lifecycle.lockPath = await acquireLock(lifecycle, versions.commonDir);
    lifecycle.timings.lockMs = Date.now() - lockStartedAt;
    lifecycle.installSignalHandlers();

    const tempStartedAt = Date.now();
    mkdirSync(tmpRoot, { recursive: true });
    const dir = mkdtempSync(join(tmpRoot, prefix));
    lifecycle.dir = dir;
    lifecycle.timings.tempMs = Date.now() - tempStartedAt;

    if (serverPort !== 0 && serverPort === webPort) {
      throw new Error("server and web ports must differ");
    }
    const config = writeServerConfig(dir, serverPort);
    const environment = sanitizedEnvironment();
    const stackStartedAt = Date.now();
    let spawnStartedAt = Date.now();

    const server = lifecycle.spawn(
      process.execPath,
      [
        versions.serverEntry,
        "serve",
        "--config",
        config,
        "--port",
        String(serverPort),
      ],
      {
        cwd: absoluteRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
      "server",
    );
    lifecycle.timings.serverSpawnMs = Date.now() - spawnStartedAt;
    let phaseStartedAt = Date.now();
    const serverMatch = await waitForLog(
      lifecycle,
      server,
      "server",
      /todou server listening on :(\d+)\b/,
      timeoutMs,
    );
    const selectedServerPort = Number(serverMatch[1]);
    if (serverPort !== 0 && selectedServerPort !== serverPort) {
      throw new Error(
        `server bound ${selectedServerPort}, expected explicit port ${serverPort}`,
      );
    }
    lifecycle.timings.serverLogMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await waitForHttp(
      lifecycle,
      server,
      `http://127.0.0.1:${selectedServerPort}/api/auth/mode`,
      "server auth mode",
      async (response) => (await response.json()).mode === "single",
      timeoutMs,
    );
    lifecycle.timings.serverHttpMs = Date.now() - phaseStartedAt;

    spawnStartedAt = Date.now();
    const web = lifecycle.spawn(
      process.execPath,
      [
        versions.viteBin,
        "--config",
        "vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--strictPort",
      ],
      {
        cwd: resolve(absoluteRoot, "projects/web"),
        env: sanitizedEnvironment({
          TODOU_API: `http://127.0.0.1:${selectedServerPort}`,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
      "vite",
    );
    lifecycle.timings.webSpawnMs = Date.now() - spawnStartedAt;
    phaseStartedAt = Date.now();
    const webMatch = await waitForLog(
      lifecycle,
      web,
      "vite",
      /Local:.*127\.0\.0\.1:(\d+)/,
      timeoutMs,
    );
    const selectedWebPort = Number(webMatch[1]);
    if (webPort !== 0 && selectedWebPort !== webPort) {
      throw new Error(
        `vite bound ${selectedWebPort}, expected explicit port ${webPort}`,
      );
    }
    lifecycle.timings.webLogMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await waitForHttp(
      lifecycle,
      web,
      `http://127.0.0.1:${selectedWebPort}${webReadyPath}`,
      "vite page",
      async (response) => (await response.text()).includes('id="root"'),
      timeoutMs,
    );
    lifecycle.timings.webHttpMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await waitForHttp(
      lifecycle,
      web,
      `http://127.0.0.1:${selectedWebPort}/api/auth/mode`,
      "vite API proxy",
      async (response) => (await response.json()).mode === "single",
      timeoutMs,
    );
    lifecycle.timings.webProxyMs = Date.now() - phaseStartedAt;

    lifecycle.serverPort = selectedServerPort;
    lifecycle.serverUrl = `http://127.0.0.1:${selectedServerPort}`;
    lifecycle.webUrl = `http://127.0.0.1:${selectedWebPort}`;
    lifecycle.artifactDir = dir;
    lifecycle.webPort = selectedWebPort;
    lifecycle.chromium = chromium;
    lifecycle.timings.readyMs = Date.now() - stackStartedAt;
    lifecycle.timings.totalMs = Date.now() - startedAt;
    console.log(
      `STACK source=${versions.source} node=${versions.node} chromium=${versions.chromium} ` +
        `server=${selectedServerPort} web=${selectedWebPort} timings=${JSON.stringify(lifecycle.timings)} ` +
        `sampleIntervalMs=${lifecycle.resources.sampleIntervalMs} dir=${dir} lock=${lifecycle.lockPath}`,
    );
    return lifecycle;
  } catch (error) {
    try {
      await lifecycle.cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "stack startup failed");
    }
    throw error;
  }
}
