import { realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { HarnessId } from "@todou/shared";
import {
  buildConfigReport,
  serverSourceLabel,
  tokenLine,
} from "./commands/config.ts";
import { integrationStatus } from "./commands/integration.ts";
import { configPath, type Env, loadCliConfigSet } from "./config.ts";
import { gitRemoteUrl, resolveContext } from "./context.ts";
import { discoverDirConfig } from "./dir-config.ts";
import type { FollowAdvice } from "./follow-advice.ts";
import { explainHarness, type SelectionTrace } from "./harness/index.ts";
import {
  type HarnessMessaging,
  ownedStateAttempt,
} from "./harness/messaging.ts";
import { isOmpWorker } from "./harness/omp.ts";
import { ompStateDir, publishedStatePids } from "./harness/omp-state.ts";
import { type ProcessTreeIo, readAncestors } from "./harness/process-tree.ts";
import { INTEGRATIONS } from "./integrations/registry.ts";
import { alive } from "./pid.ts";

/**
 * The variables follow depends on, in the order a reader checks them. An
 * allowlist rather than a dump: the environment of an agent shell holds API
 * keys for everything the user has ever configured, and this report is made
 * to be pasted where other people read it.
 *
 * `secret` entries are reported as set or unset and never by value.
 */
const VARIABLES: readonly { name: string; secret?: true }[] = [
  { name: "OMPCODE" },
  { name: "CLAUDECODE" },
  { name: "CLAUDE_CODE_MESSAGING_SOCKET" },
  { name: "CLAUDE_CODE_MESSAGING_TOKEN", secret: true },
  { name: "CODEX_THREAD_ID" },
  { name: "TODOU_CODEX_BIN" },
  { name: "PI_CODING_AGENT" },
  { name: "PI_SESSION_ID" },
  { name: "HERMES_REAL_HOME" },
  { name: "HERMES_SESSION_KEY", secret: true },
  { name: "_HERMES_GATEWAY" },
  { name: "TODOU_OMP_STATE" },
  { name: "TODOU_PI_STATE" },
  { name: "TODOU_MESSAGING_SOCKET" },
  { name: "TODOU_MESSAGING_TOKEN", secret: true },
  { name: "TODOU_OMP_TOOLS" },
  { name: "TODOU_SERVER" },
  { name: "TODOU_PROJECT" },
  { name: "TODOU_PROFILE" },
  { name: "TODOU_TOKEN", secret: true },
  { name: "XDG_RUNTIME_DIR" },
  { name: "XDG_CONFIG_HOME" },
];

/**
 * What an ancestor's environment is allowed to say about itself: which of
 * these it carries, never their values. These are the markers detection
 * reads, plus the channel variables a host hands down — the pair that showed
 * T-564's broker as the boundary it was not.
 */
const MARKERS = [
  "OMPCODE",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "PI_CODING_AGENT",
  "HERMES_REAL_HOME",
  "HERMES_SESSION_KEY",
  "_HERMES_GATEWAY",
  "TODOU_OMP_STATE",
  "TODOU_PI_STATE",
  "TODOU_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_SOCKET",
];

/** Long enough for `omp __omp_worker_daemon_broker`, short of a pasted prompt. */
const ARGV_CHARS = 120;

/** Shorter values are left alone: masking `1` would mask every `1`. */
const MIN_SECRET_CHARS = 6;

/** A personal access token, whether or not this process knows its value. */
const PAT = /todou_pat_[A-Za-z0-9_-]+/g;

const REDACTED = "<redacted>";

export type DoctorInput = {
  env: Env;
  cwd: string;
  home: string;
  processTree?: Partial<ProcessTreeIo>;
  version: string;
  /** The script this process is running, `process.argv[1]`. */
  script: string | undefined;
  advice: FollowAdvice;
  messaging: HarnessMessaging;
  optedOut: boolean;
};

function row(label: string, value: string): string {
  return `${label.padEnd(12)} ${value}`;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function executable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Which `todou` this is, and which ones a fresh shell would find instead.
 * T-564's named service ran an older install because omp had reset its PATH,
 * and nothing in the output it produced said so.
 */
function binaries(input: DoctorInput): string[] {
  const running = input.script ? realpath(input.script) : undefined;
  const lines = [
    row(
      "running",
      input.script === undefined
        ? "(unknown)"
        : running === input.script
          ? input.script
          : `${input.script} → ${running}`,
    ),
  ];
  const found = (input.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, "todou"))
    .filter(executable);
  if (found.length === 0) {
    lines.push(row("on PATH", "no todou on PATH"));
  }
  found.forEach((path, i) => {
    const notes = [
      ...(i === 0 ? ["first"] : []),
      ...(realpath(path) === running ? ["this one"] : []),
    ];
    lines.push(
      row(
        i === 0 ? "on PATH" : "",
        notes.length === 0 ? path : `${path}  ← ${notes.join(", ")}`,
      ),
    );
  });
  lines.push(row("PATH", input.env.PATH ?? "(unset)"));
  lines.push(row("cwd", input.cwd));
  return lines;
}

export function harnessRoute(
  id: HarnessId | null,
  trace: SelectionTrace,
): string {
  const depth = (d: number | null | undefined) =>
    d === null || d === undefined ? "not attributable" : `depth ${d}`;
  const depths = trace.candidates
    .map((c) => `${c} ${depth(trace.depths[c])}`)
    .join(", ");
  switch (trace.route) {
    case "none":
      return "none — no harness marker in this environment and no published record above it";
    case "only-candidate":
      return `${id} — the only candidate (${depths})`;
    case "nearest-host": {
      // `select` takes the first of equally near hosts, so a tie is the
      // registry order deciding and must not read as the tree having done it.
      const nearest = id === null ? undefined : trace.depths[id];
      const tied = trace.candidates.filter(
        (c) => trace.depths[c] === nearest,
      ).length;
      return tied > 1
        ? `${id} — tied for nearest host in the process tree, registry order decides (${depths})`
        : `${id} — nearest host in the process tree (${depths})`;
    }
    case "registry-order":
      return `${id} — no candidate attributable in the process tree, registry order decides (${depths})`;
    case "published-record":
      return `${id} — named by the record pid ${trace.published?.pid} published at ${trace.published?.path}`;
    default:
      // A route added to `select` before this report learns to word it is
      // still printed by name: the report exists to show the decision, and a
      // line missing here would hide exactly the case nobody has seen yet.
      return `${id ?? "none"} — route ${String(trace.route)} (${depths || "no candidates"})`;
  }
}

function harnessLines(
  input: DoctorInput,
  mask: (text: string) => string,
): string[] {
  const { id, trace, hostPid } = explainHarness(input.env, input.processTree);
  const chain = readAncestors(input.processTree);
  const published = new Set(publishedStatePids(input.env));
  const lines = [
    row("harness", harnessRoute(id, trace)),
    row(
      "candidates",
      trace.candidates.length === 0
        ? "none (environment markers)"
        : `${trace.candidates.join(", ")} (environment markers)`,
    ),
  ];
  if (chain.length === 0) {
    lines.push(
      "process tree unavailable — no /proc here, or no ancestor runs as this user",
    );
    return lines;
  }
  lines.push("process tree (nearest first; markers named, never their values)");
  chain.forEach((ancestor, i) => {
    // Masked before it is cut: a token split by the cut would no longer
    // match itself, and its first half would go out in the clear.
    const argv = mask(ancestor.argv.join(" "));
    const shown =
      argv.length > ARGV_CHARS ? `${argv.slice(0, ARGV_CHARS - 1)}…` : argv;
    const notes = [
      ...MARKERS.filter((name) => ancestor.env[name] !== undefined),
      ...(isOmpWorker(ancestor) ? ["omp worker — skipped"] : []),
      ...(ancestor.pid === hostPid ? [`${id} host`] : []),
      ...(published.has(ancestor.pid)
        ? [`published ${ancestor.pid}.json`]
        : []),
    ];
    lines.push(
      `  ${String(i).padEnd(2)} ${String(ancestor.pid).padEnd(7)} ${shown || "(no argv)"}` +
        (notes.length === 0 ? "" : `  · ${notes.join(" ")}`),
    );
  });
  return lines;
}

function environmentLines(env: Env): string[] {
  const set = VARIABLES.filter((v) => env[v.name] !== undefined);
  const unset = VARIABLES.filter((v) => env[v.name] === undefined);
  return [
    "environment",
    ...set.map(
      (v) => `  ${v.name}=${v.secret ? REDACTED : (env[v.name] as string)}`,
    ),
    ...(unset.length === 0
      ? []
      : [`  unset: ${unset.map((v) => v.name).join(" ")}`]),
  ];
}

/**
 * Which server and which identity a bare command here would use — the
 * question T-564's `todou_watch` got wrong. The same resolution `config show`
 * prints, so the two reports cannot disagree.
 */
function accountLines(input: DoctorInput): string[] {
  try {
    const { config, files } = loadCliConfigSet(input.env);
    const ctx = resolveContext({
      flags: {},
      env: input.env,
      config,
      remoteUrl: gitRemoteUrl(input.cwd),
      dirConfig: discoverDirConfig(input.cwd, input.env),
    });
    const report = buildConfigReport({
      version: input.version,
      config,
      files,
      ctx,
      env: input.env,
    });
    const source = serverSourceLabel(report, input.cwd);
    const server = report.context.server;
    const active = report.servers.find((s) => s.active);
    return [
      row(
        "account",
        `${server === null ? "no server resolved" : server}${source === null ? "" : ` (${source})`} · token: ${tokenLine(report)}`,
      ),
      ...(active === undefined
        ? []
        : [
            row(
              "",
              `stored for this server: ${active.default_token ? "default token" : "no default token"} · profiles ${active.profiles.length === 0 ? "none" : active.profiles.join(", ")}`,
            ),
          ]),
    ];
  } catch (error) {
    return [row("account", `could not resolve — ${(error as Error).message}`)];
  }
}

function socketState(path: string): string {
  try {
    return statSync(path).isSocket() ? "exists" : "exists, not a socket";
  } catch {
    return "missing";
  }
}

function pushLines(input: DoctorInput, harness: string | null): string[] {
  const m = input.messaging;
  const lines: string[] = [];
  if (m.codex) {
    lines.push(
      row(
        "push",
        `codex · thread ${m.codex.threadId} · queue via ${m.codex.bin}`,
      ),
    );
  } else if (m.socket) {
    lines.push(
      row(
        "push",
        `${m.peer ?? "unknown peer"} · socket ${m.socket} (${socketState(m.socket)}) · token ${m.token ? "present" : "absent"} · tools ${m.tools?.join(", ") || "none"}`,
      ),
    );
  } else {
    lines.push(row("push", "none found"));
  }
  if (harness === "omp" || harness === "pi") {
    const attempt = ownedStateAttempt(harness, input.env, input.processTree);
    lines.push(
      row(
        "record",
        attempt.state
          ? `${attempt.state.path} read · pid ${attempt.state.pid} · session ${attempt.state.sessionId}`
          : attempt.unreadable
            ? `${attempt.unreadable} could not be read or believed`
            : "none published by a process above this one",
      ),
    );
  }
  const pids = publishedStatePids(input.env);
  lines.push(
    row(
      "published",
      `${ompStateDir(input.env)}: ${
        pids.length === 0
          ? "nothing"
          : pids
              .map((pid) => `${pid} (${alive(pid) ? "alive" : "dead"})`)
              .join(", ")
      }`,
    ),
  );
  return lines;
}

/**
 * Every token this process can see, from each place one is kept: the
 * environment, the user config, and the push channel — which, under omp and
 * pi, is the published record's token. Collected before anything is rendered, because the argv masking
 * below has to know all of them before it cuts a line short.
 */
function secretsOf(input: DoctorInput): string[] {
  const secrets = VARIABLES.filter((v) => v.secret)
    .map((v) => input.env[v.name])
    .filter((v): v is string => v !== undefined);
  if (input.messaging.token) secrets.push(input.messaging.token);
  try {
    for (const entry of Object.values(
      loadCliConfigSet(input.env).config.servers,
    )) {
      if (entry.token) secrets.push(entry.token);
      secrets.push(...Object.values(entry.tokens));
    }
  } catch {
    // A config that does not parse holds nothing the report reads either.
  }
  return secrets;
}

/**
 * Masks every known token, and anything shaped like a personal access token
 * whether this process knows its value or not. Applied again to the finished
 * text rather than trusted to each section, since an ancestor's argv can carry
 * a token nobody meant to put there.
 */
function masker(secrets: readonly string[]): (text: string) => string {
  const known = [...new Set(secrets)]
    .filter((s) => s.length >= MIN_SECRET_CHARS)
    // Longest first, so a token containing another is masked whole.
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const secret of known) out = out.replaceAll(secret, REDACTED);
    return out.replace(PAT, `todou_pat_${REDACTED}`);
  };
}

/** Fewer user names in a pasted report; the paths stay readable. */
function tildeAll(text: string, env: Env): string {
  const home = env.HOME;
  if (!home || home === "/") return text;
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  return text.replaceAll(`${base}/`, "~/");
}

/** The report `todou agent doctor` prints, as one string ending in a newline. */
export function doctorReport(input: DoctorInput): string {
  const { harness } = input.advice;
  const mask = masker(secretsOf(input));
  const home = input.home;
  const lines = [
    row(
      "todou",
      `${input.version} · node ${process.version} · ${process.platform}`,
    ),
    ...binaries(input),
    "",
    ...harnessLines(input, mask),
    ...environmentLines(input.env),
    "",
    ...accountLines(input),
    ...pushLines(input, harness),
    "integrations",
    ...INTEGRATIONS.map(
      (entry) => `  ${integrationStatus(entry, input.env, home).line}`,
    ),
    row(
      "config",
      `${configPath(input.env)} · follow_uds ${input.optedOut ? "opted out" : "advised"}`,
    ),
    row("advice", input.advice.situation),
  ];
  return `${tildeAll(mask(lines.join("\n")), input.env)}\n`;
}
