import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { Env } from "../config.ts";

/** What the extension publishes, once every field has been believed. */
export type OmpState = {
  /** The session omp holds right now. */
  sessionId: string;
  /** Its log, when the record named a usable one; the model is read there. */
  sessionFile?: string;
  /** Where this was read from, for a diagnostic that names the file. */
  path: string;
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
  let record: {
    v?: unknown;
    pid?: unknown;
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
  };
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
