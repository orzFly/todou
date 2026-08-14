import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import { findInJsonlTail } from "./jsonl-tail.ts";
import type { Harness, HostProcess } from "./types.ts";

/** Enough for the header line pi writes; anything longer is not one. */
const HEADER_BYTES = 4096;
/** Bounds the header reads when a project has a deep session archive. */
const MAX_CANDIDATES = 64;

/**
 * pi (earendil-works/pi). `PI_CODING_AGENT=true`, set by pi on itself at
 * startup and inherited by every child, is the only thing pi puts in the
 * environment — there is no session or model variable to read, so both are
 * recovered from the session log pi appends to as the turn runs.
 */
export const pi = {
  id: "pi",
  matches: (env) => env.PI_CODING_AGENT === "true",
  context({ env, home, cwd, host }) {
    const context: AgentContext = { agent: "pi" };
    const file = currentSessionFile(env, home, cwd, host());
    if (!file) return context;
    context.session_id = file.id;
    const model = findInJsonlTail(file.path, modelFromLine);
    if (model) context.model = model;
    return context;
  },
} satisfies Harness;

/**
 * The live session, identified by recency: pi appends the user's message
 * before running the tool that invokes us, so among the sessions that could
 * be ours the live one is always the most recently written.
 *
 * Recency stays the selector even now that the host process is known, because
 * `/resume` switches sessions from inside a running pi: the argv it started
 * with names a session it may have long left, while the one it is appending
 * to is by definition the most recently written. So the host only ever says
 * *where to look* (T-128).
 *
 * Two pi instances open on the same project remain genuinely ambiguous — no
 * fd to inspect, nothing in the environment, and argv defeated by `/resume` —
 * and this still resolves to whichever spoke last.
 */
function currentSessionFile(
  env: Env,
  home: string,
  cwd: string,
  host: HostProcess | undefined,
): { id: string; path: string } | undefined {
  const here = resolve(cwd);
  const hostCwd = host?.cwd ? resolve(host.cwd) : undefined;
  const scanned: { path: string; mtime: number; explicit?: true }[] = [];
  for (const dir of sessionDirs(env, home, here, host)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // No session has ever been recorded for this directory.
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        scanned.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        // Raced with a session being deleted; simply not a candidate.
      }
    }
  }
  scanned.sort((a, b) => b.mtime - a.mtime);

  // `--session <path>` may point outside every directory scanned above, so it
  // is added after the cap rather than competing for a place under it.
  const candidates = scanned.slice(0, MAX_CANDIDATES);
  const named = host && flagValue(host.argv, "--session");
  if (named) {
    try {
      const path = resolve(named);
      candidates.push({ path, mtime: statSync(path).mtimeMs, explicit: true });
    } catch {
      // Named a file we cannot stat; the scan still stands on its own.
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
  }

  for (const { path, explicit } of candidates) {
    const header = sessionHeader(path);
    if (!header) continue;
    // A session whose cwd does not contain ours belongs to another project:
    // the only filter available under --session-dir, where pi drops every
    // project's sessions into one flat directory. A file pi was handed by
    // path is its own by construction, so the filter has nothing to add.
    //
    // pi's own cwd answers the same question more directly when the host is
    // known, and is accepted alongside rather than instead of ours: /proc
    // resolves symlinks while pi records the path it was handed, so either
    // one can be the one that matches.
    if (
      explicit ||
      contains(header.cwd, here) ||
      (hostCwd !== undefined && contains(header.cwd, hostCwd))
    ) {
      return { id: header.id, path };
    }
  }
  return undefined;
}

/** Reads `--flag value` and `--flag=value` alike. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * Where pi could be keeping this project's sessions. The default layout
 * encodes pi's own cwd in the directory name, and a tool may well run us
 * from a subdirectory of it, so every ancestor is a candidate.
 */
function sessionDirs(
  env: Env,
  home: string,
  cwd: string,
  host: HostProcess | undefined,
): string[] {
  // `||`, not `??`: pi itself reads this variable for truthiness, so a
  // bound-but-empty value means "unset" to pi and must mean the same here
  // (T-120). The same holds for the agent directory below.
  //
  // The flag beats the variable: it is the more specific, per-invocation
  // choice, and being a command-line argument it is invisible from the
  // environment — which is why this mode used to degrade to no session at
  // all (T-108, fixed by reading the host's argv).
  const flat =
    (host && flagValue(host.argv, "--session-dir")) ||
    env.PI_CODING_AGENT_SESSION_DIR;
  // --session-dir and its variable override the per-project layout entirely,
  // pointing every project at one directory rather than a subdirectory of it.
  if (flat) return [flat];
  const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const dirs: string[] = [];
  // pi's own cwd is what the directory name encodes, so the host answers
  // directly what walking our ancestors can only guess at. Both are kept:
  // /proc resolves symlinks while pi records the logical path it was given,
  // and the two can disagree.
  const roots: string[] = host?.cwd ? [resolve(host.cwd)] : [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    roots.push(dir);
    if (dirname(dir) === dir) break;
  }
  for (const root of roots) {
    const dir = join(agentDir, "sessions", sessionDirName(root));
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** pi's own encoding of a cwd into one directory name. */
function sessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function contains(parent: string, child: string): boolean {
  const base = resolve(parent);
  return (
    child === base || child.startsWith(base.endsWith(sep) ? base : base + sep)
  );
}

/** pi writes the session id and cwd as the first line of every session file. */
function sessionHeader(path: string): { id: string; cwd: string } | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const filled = readSync(fd, buffer, 0, HEADER_BYTES, 0);
      const newline = buffer.subarray(0, filled).indexOf(0x0a);
      if (newline === -1) return undefined;
      const entry = JSON.parse(buffer.toString("utf8", 0, newline)) as {
        type?: string;
        id?: unknown;
        cwd?: unknown;
      };
      if (
        entry.type === "session" &&
        typeof entry.id === "string" &&
        entry.id !== "" &&
        typeof entry.cwd === "string" &&
        entry.cwd !== ""
      ) {
        return { id: entry.id, cwd: entry.cwd };
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable or foreign file: not a session we can claim.
  }
  return undefined;
}

/**
 * pi resolves the live model by replaying the session and keeping the last
 * `model_change` or assistant message, whichever came later — so the newest
 * of either in the file is the answer. The provider qualifies the id the way
 * pi's own `--model provider/id` syntax does, because one id can be served by
 * several providers (an aggregator makes that the normal case, not an edge).
 *
 * Read backwards over the raw file rather than following parentId links: a
 * branched session can leave an abandoned entry newer than the current path's,
 * which costs at most a stale model on the turn right after a branch, and
 * buys a bounded read instead of parsing the session whole.
 */
function modelFromLine(line: string): string | undefined {
  if (!line.includes('"model')) return undefined;
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      provider?: unknown;
      modelId?: unknown;
      message?: { role?: string; provider?: unknown; model?: unknown };
    };
    if (entry.type === "model_change") {
      return qualified(entry.provider, entry.modelId);
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      return qualified(entry.message.provider, entry.message.model);
    }
  } catch {
    // Half-written last line, a chunk-boundary fragment, or a foreign format.
  }
  return undefined;
}

function qualified(provider: unknown, model: unknown): string | undefined {
  if (typeof model !== "string" || model === "") return undefined;
  return typeof provider === "string" && provider !== ""
    ? `${provider}/${model}`
    : model;
}
