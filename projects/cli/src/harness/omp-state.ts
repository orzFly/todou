import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { Env } from "../config.ts";

/** What the extension publishes, once every field has been believed. */
export type OmpState = {
  /** The session omp holds right now. */
  sessionId: string;
  /** Its log, when the record named a usable one; the model is read there. */
  sessionFile?: string;
  /** Where this was read from, for a diagnostic that names the file. */
  path: string;
  /** The process that published it, already checked against `path` and /proc. */
  pid: number;
  /**
   * Which harness wrote this, when the record said. Detection reads it rather
   * than assuming omp: the record layout is the extension's, and a second
   * harness adopting it must not be silently reported as the first.
   */
  agent?: string;
};

/** The only record layout this reads; anything else is treated as absent. */
const VERSION = 1;

/** It ends up in a URL — the same guard the claude-code detector applies. */
const SESSION_ID = /^[0-9a-zA-Z-]+$/;

/**
 * The session id omp itself published, from the state file the todou omp
 * extension writes (`todou integration install omp`).
 *
 * omp exports no session variable of its own, so without the extension the
 * detector has to pick the project's most recently written session log and
 * hope — which two omp instances on one project, or a write interleaved with
 * a tool call, defeat by construction (T-109). This is omp saying who it is.
 *
 * Parsed by hand, field by field, like `claude-code.ts` reading
 * `~/.claude/sessions/<pid>.json`: the record is written by a process outside
 * this one's control, so every field is checked before it is believed and any
 * doubt returns undefined. The caller falls back to the scan, which is what
 * every environment without the extension does anyway.
 */
export function readOmpState(env: Env): OmpState | undefined {
  const path = env.TODOU_OMP_STATE;
  if (!path) return undefined;
  return readOmpStateAt(path);
}

/**
 * The same record, read from a path the caller located some other way than by
 * being handed it in the environment.
 *
 * Split out because the variable is the weaker of the two ways to find this
 * file: omp builds a curated environment for its non-tool contexts and the
 * variable is not in it, so anything that is not omp's own bash tool sees
 * nothing — which was T-312, an omp session reporting no session at all for as
 * long as it took the first turn to create the log.
 */
export function readOmpStateAt(path: string): OmpState | undefined {
  let record: {
    v?: unknown;
    pid?: unknown;
    agent?: unknown;
    session_id?: unknown;
    session_file?: unknown;
  };
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Absent, half-written, or unreadable: the scan still stands on its own.
    return undefined;
  }
  if (record.v !== VERSION) return undefined;
  // Records outlive the processes they name and pids get reused, so the pid
  // is checked twice over: against the one the path names, which is what ties
  // this record to the file we were pointed at rather than to a copy of it,
  // and against the process table, which is what a crash between the last
  // write and `session_shutdown` leaves behind. Neither is free-standing —
  // together they say "the omp that wrote this is the omp above us".
  if (typeof record.pid !== "number" || record.pid !== pidFromPath(path)) {
    return undefined;
  }
  if (!alive(record.pid)) return undefined;
  const sessionId = record.session_id;
  if (
    typeof sessionId !== "string" ||
    sessionId.length > 200 ||
    !SESSION_ID.test(sessionId)
  ) {
    return undefined;
  }
  const sessionFile = record.session_file;
  return {
    sessionId,
    // Absent is a session with no model rather than a reason to reject the
    // id: the id is what this exists to publish, and a scan run for the model
    // alone could only offer another session's.
    ...(typeof sessionFile === "string" && isAbsolute(sessionFile)
      ? { sessionFile }
      : {}),
    path,
    pid: record.pid,
    ...(typeof record.agent === "string" && record.agent !== ""
      ? { agent: record.agent }
      : {}),
  };
}

/**
 * Where the extension publishes, resolved the way the extension resolves it.
 *
 * `||`, not `??`: a bound-but-empty value means "unset" to the extension too,
 * and the two have to agree on the directory or the reader looks somewhere the
 * writer never wrote. Read from our own environment rather than omp's — the
 * variable was measured identical in every context this reaches, and a
 * disagreement costs a lookup that finds nothing and falls through to the
 * descriptor, never a wrong answer.
 */
export function ompStateDir(env: Env): string {
  return join(env.XDG_RUNTIME_DIR || tmpdir(), "todou-omp");
}

/**
 * The pids that have published a record, from one listing of the directory.
 *
 * This exists to be the cheap half of the lookup: a machine that never
 * installed the extension answers with one failed `readdir` and no process
 * tree walked at all.
 */
export function publishedStatePids(env: Env): readonly number[] {
  let names: string[];
  try {
    names = readdirSync(ompStateDir(env));
  } catch {
    return []; // No extension has ever published here.
  }
  const pids: number[] = [];
  for (const name of names) {
    // The sockets of the push channel live in the same directory.
    if (!name.endsWith(".json")) continue;
    const pid = Number(basename(name, ".json"));
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * The session omp published, found by asking which of our ancestors published
 * it rather than by trusting a variable to have reached us.
 *
 * Nearest ancestor first, which is what makes an omp running inside another
 * omp's bash tool resolve to itself: an inherited `TODOU_OMP_STATE` names the
 * outer one, and the extension carries its own guard against exactly that.
 * Here the pid in the path *is* the question, so the nearer publisher wins by
 * construction.
 *
 * `ancestors` is a thunk so the cheap directory listing above can rule the
 * whole thing out before a process tree is walked — on macOS that walk costs a
 * `ps` spawn.
 */
export function publishedState(
  env: Env,
  ancestors: () => readonly number[],
): OmpState | undefined {
  return publishedStateAttempt(env, ancestors).state;
}

/**
 * The same lookup, keeping the difference between "no ancestor published" and
 * "one did and its record would not read". Only the re-readable probe needs
 * that difference: falling back quietly there restores the startup snapshot it
 * exists to replace (T-289), so the failure has to be reportable.
 */
export function publishedStateAttempt(
  env: Env,
  ancestors: () => readonly number[],
): { state?: OmpState; unreadable?: string } {
  const published = publishedStatePids(env);
  if (published.length === 0) return {};
  const dir = ompStateDir(env);
  const known = new Set(published);
  let unreadable: string | undefined;
  for (const pid of ancestors()) {
    if (!known.has(pid)) continue;
    const path = join(dir, `${pid}.json`);
    const state = readOmpStateAt(path);
    if (state) return { state };
    // Named but not believed. Kept rather than returned, because a nearer
    // ancestor's unusable record must not hide a further one's good record —
    // the nesting case this walk exists to get right.
    unreadable ??= path;
  }
  return unreadable === undefined ? {} : { unreadable };
}

/** `…/todou-omp/<pid>.json`, or undefined when the name is not a pid. */
function pidFromPath(path: string): number | undefined {
  const name = basename(path, ".json");
  if (!/^[0-9]+$/.test(name)) return undefined;
  return Number(name);
}

/**
 * Signal 0 checks for a process without touching it. EPERM counts as alive:
 * the pid is in use by somebody, which is all this asks.
 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
