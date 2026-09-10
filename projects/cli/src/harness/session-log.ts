import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Enough for the opening entries of a session file; anything longer is not one. */
const HEADER_BYTES = 4096;
/** Bounds the header reads when a project has a deep session archive. */
const MAX_CANDIDATES = 64;

/**
 * How stale a session log may be and still be taken for the live one.
 *
 * The bound is not there to break ties. A live session's log is *seconds*
 * old — the harness appends the user's message and then runs the tool that
 * invokes us — so this sits three orders of magnitude clear of any real
 * answer and never decides between two plausible ones.
 *
 * It is there for the case where the right answer is "no session at all".
 * Under `--no-session` the harness writes no log, and recency on its own
 * then returns whatever this project last wrote, however long dead: a real
 * id, for a real past session, reported as the current one. That is worse
 * than reporting nothing, and nothing is what a floor gets us.
 */
const MAX_AGE_MS = 60 * 60 * 1000;

/** The identity a session file states about itself in its opening entries. */
export type SessionHeader = { id: string; cwd: string };

/**
 * The live session of a pi-lineage harness — pi itself and its fork omp,
 * which record the same append-only JSONL per session and file it per
 * project. Only *where* to look and how the model is spelled differ, so both
 * detectors hand this the directories to scan and read their own model out of
 * the file it returns.
 *
 * There are two ways to answer, and the first one is not a heuristic: a
 * harness that holds its log open for append says which session it is in,
 * and `hostPid` is where that gets asked. Only harnesses measured to hold
 * exactly one such descriptor pass it — see the call sites.
 *
 * Where that cannot be asked, recency is the selector: the harness appends
 * the user's message before running the tool that invokes us, so among the
 * sessions that could be ours the live one is the most recently written. It
 * stays the selector even when the host process is known, because `/resume`
 * switches sessions from inside a running harness: the argv it started with
 * names a session it may have long left, while the one it is appending to is
 * by definition the most recently written. So the host only ever says *where
 * to look* (T-128).
 *
 * Recency alone cannot tell two live instances apart, and it cannot tell a
 * live session from this project's archive when the harness is writing no log
 * at all. The descriptor settles the first; `MAX_AGE_MS` bounds the second.
 */
export function currentSessionFile(opts: {
  /** Where this harness could be keeping this project's sessions. */
  dirs: readonly string[];
  /** Our own cwd, resolved. */
  cwd: string;
  /** The host process's cwd, resolved, when the tree could name one. */
  hostCwd?: string;
  /** A session file named on the host's argv, which may sit outside `dirs`. */
  explicit?: string;
  /**
   * The logs the harness process holds open (`HostProcess.openLogs`). Omitted
   * by harnesses not measured to hold theirs open, which is the whole of the
   * opt-in — see the call sites.
   */
  openLogs?: readonly string[];
}): { id: string; path: string } | undefined {
  const held = opts.openLogs?.[0];
  if (opts.openLogs?.length === 1 && held !== undefined) {
    // The descriptor outranks everything below, `explicit` included: argv says
    // what the harness was started with, the descriptor what it is appending
    // to now, and `/resume` is exactly where those two part company.
    const header = sessionHeader(held);
    return header ? { id: header.id, path: held } : undefined;
  }
  // Readable, and naming no log at all: this harness is writing no session.
  // Falling through to recency here would hand back the project's newest
  // archived session as though it were the current one.
  if (opts.openLogs?.length === 0) return undefined;
  // Everything else — not opted in, table unreadable, or several logs with
  // nothing to say which is live — leaves recency to answer.

  // Anything older than this is not what the harness is writing right now,
  // whatever else it may be the newest of.
  const cutoff = Date.now() - MAX_AGE_MS;
  const scanned: { path: string; mtime: number; explicit?: true }[] = [];
  for (const dir of opts.dirs) {
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
        const mtime = statSync(path).mtimeMs;
        if (mtime >= cutoff) scanned.push({ path, mtime });
      } catch {
        // Raced with a session being deleted; simply not a candidate.
      }
    }
  }
  scanned.sort((a, b) => b.mtime - a.mtime);

  // A file named by flag may point outside every directory scanned above, so
  // it is added after the cap rather than competing for a place under it.
  const candidates = scanned.slice(0, MAX_CANDIDATES);
  if (opts.explicit) {
    try {
      const path = resolve(opts.explicit);
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
    // the only filter available under a flat session directory, where every
    // project's sessions land side by side. A file the harness was handed by
    // path is its own by construction, so the filter has nothing to add.
    //
    // The harness's own cwd answers the same question more directly when the
    // host is known, and is accepted alongside rather than instead of ours:
    // /proc resolves symlinks while the header records the path the harness
    // was handed, so either one can be the one that matches.
    if (
      explicit ||
      contains(header.cwd, opts.cwd) ||
      (opts.hostCwd !== undefined && contains(header.cwd, opts.hostCwd))
    ) {
      return { id: header.id, path };
    }
  }
  return undefined;
}

/** Reads `--flag value` and `--flag=value` alike. */
export function flagValue(
  argv: readonly string[],
  flag: string,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function contains(parent: string, child: string): boolean {
  const base = resolve(parent);
  return (
    child === base || child.startsWith(base.endsWith(sep) ? base : base + sep)
  );
}

/**
 * The session entry, which states the id and the cwd. pi writes it as the
 * first line; omp opens with a fixed-width title slot it rewrites in place
 * and writes the session entry second — so the opening lines are scanned
 * rather than just the first, and a file that has not declared itself within
 * the first few hundred bytes is not one we can claim.
 */
function sessionHeader(path: string): SessionHeader | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const filled = readSync(fd, buffer, 0, HEADER_BYTES, 0);
      const text = buffer.toString("utf8", 0, filled);
      // The last element is a fragment unless the read ended on a newline;
      // a truncated line simply fails to parse.
      for (const line of text.split("\n")) {
        const header = parseHeaderLine(line);
        if (header) return header;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable or foreign file: not a session we can claim.
  }
  return undefined;
}

function parseHeaderLine(line: string): SessionHeader | undefined {
  if (!line.includes('"session"')) return undefined;
  try {
    const entry = JSON.parse(line) as {
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
  } catch {
    // Half-written line, a chunk-boundary fragment, or a foreign format.
  }
  return undefined;
}
