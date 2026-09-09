import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Enough for the opening entries of a session file; anything longer is not one. */
const HEADER_BYTES = 4096;
/** Bounds the header reads when a project has a deep session archive. */
const MAX_CANDIDATES = 64;

/** The identity a session file states about itself in its opening entries. */
export type SessionHeader = { id: string; cwd: string };

/**
 * The live session of a pi-lineage harness — pi itself and its fork omp,
 * which record the same append-only JSONL per session and file it per
 * project. Only *where* to look and how the model is spelled differ, so both
 * detectors hand this the directories to scan and read their own model out of
 * the file it returns.
 *
 * Recency is the selector: the harness appends the user's message before
 * running the tool that invokes us, so among the sessions that could be ours
 * the live one is always the most recently written. It stays the selector
 * even when the host process is known, because `/resume` switches sessions
 * from inside a running harness: the argv it started with names a session it
 * may have long left, while the one it is appending to is by definition the
 * most recently written. So the host only ever says *where to look* (T-128).
 *
 * Two instances open on the same project remain genuinely ambiguous — no fd
 * to inspect, nothing in the environment, and argv defeated by `/resume` —
 * and this still resolves to whichever spoke last.
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
}): { id: string; path: string } | undefined {
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
        scanned.push({ path, mtime: statSync(path).mtimeMs });
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
