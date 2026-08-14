import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../config.ts";

/** One ancestor process, ordered from our parent outwards. */
export type Ancestor = {
  pid: number;
  uid: number;
  /**
   * The environment block the process was *exec'd* with. A variable the
   * process set on itself afterwards is deliberately absent: that absence is
   * exactly what marks it as the one that introduced the variable for its
   * children (T-128).
   */
  env: Env;
  argv: readonly string[];
  /** Linux only: macOS would need an `lsof` spawn to answer this. */
  cwd?: string;
};

/**
 * Injected so tests never touch the real process tree — reading it would make
 * every result depend on which harness happened to run the suite.
 */
export type ProcessTreeIo = {
  platform: NodeJS.Platform;
  /** Where the chain starts: our parent. */
  startPid: number;
  procRoot: string;
  ps(args: readonly string[]): string;
};

/** Real chains run ~10 deep; 32 bounds a cycle or a pathological tree. */
const MAX_DEPTH = 32;

let cached: readonly Ancestor[] | undefined;

/**
 * Our ancestors, nearest first, for as far as they can be attributed to us.
 *
 * Only same-uid ancestors are collected: a privilege boundary hides the
 * environment behind it, and the two platforms report that differently
 * (Linux raises EACCES, macOS `ps` silently omits the environment), so the
 * uid is compared explicitly rather than trusting either error path.
 *
 * Every failure yields a shorter chain, never a throw — a chain we could not
 * walk simply leaves the registry order in charge.
 */
export function readAncestors(
  io?: Partial<ProcessTreeIo>,
): readonly Ancestor[] {
  // Only the real tree is cached: an injected fixture must not leak into the
  // next call, and the tree cannot change within one CLI invocation anyway.
  if (io === undefined && cached !== undefined) return cached;
  const ancestors = collect(io);
  if (io === undefined) cached = ancestors;
  return ancestors;
}

function collect(io?: Partial<ProcessTreeIo>): readonly Ancestor[] {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return []; // no uid means no same-uid rule: Windows
    const startPid = io?.startPid ?? process.ppid;
    switch (io?.platform ?? process.platform) {
      case "linux":
        return fromProc(startPid, uid, io?.procRoot ?? "/proc");
      case "darwin":
        return fromPs(startPid, uid, io?.ps ?? runPs);
      default:
        return [];
    }
  } catch {
    // An unreadable process tree is never an error.
    return [];
  }
}

/* -------------------------------------------------------------- Linux */

function fromProc(
  startPid: number,
  uid: number,
  root: string,
): readonly Ancestor[] {
  const ancestors: Ancestor[] = [];
  let pid = startPid;
  for (let depth = 0; depth < MAX_DEPTH && pid > 0; depth++) {
    let entry: { ancestor: Ancestor; ppid: number };
    try {
      entry = procEntry(pid, root);
    } catch {
      break; // unreadable: the chain ends here
    }
    if (entry.ancestor.uid !== uid) break;
    ancestors.push(entry.ancestor);
    if (entry.ppid <= 0 || entry.ppid === pid) break;
    pid = entry.ppid;
  }
  return ancestors;
}

function procEntry(
  pid: number,
  root: string,
): { ancestor: Ancestor; ppid: number } {
  const dir = join(root, String(pid));
  // The directory's owner is the process owner, and one stat is cheaper than
  // parsing the Uid line out of `status`.
  const uid = statSync(dir).uid;
  const stat = readFileSync(join(dir, "stat"), "utf8");
  // comm is parenthesised and may itself hold spaces and parentheses, so the
  // fields after it are only unambiguous counting from the last ')'.
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  const env = parseNulSeparated(readFileSync(join(dir, "environ"), "utf8"));
  const argv = readFileSync(join(dir, "cmdline"), "utf8")
    .split("\0")
    .filter(Boolean);
  let cwd: string | undefined;
  try {
    cwd = readlinkSync(join(dir, "cwd"));
  } catch {
    // A cwd we cannot resolve costs a locator, not the ancestor.
  }
  return { ancestor: { pid, uid, env, argv, cwd }, ppid };
}

function parseNulSeparated(raw: string): Env {
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/* ------------------------------------------------------------- macOS */

function runPs(args: readonly string[]): string {
  const res = spawnSync("ps", [...args], { encoding: "utf8" });
  if (res.error || res.status !== 0) throw new Error("ps failed");
  return res.stdout;
}

/**
 * Exactly two spawns: one table to walk the chain locally, one batched read of
 * the environments. Asking `ps` per level instead would cost a spawn each.
 */
function fromPs(
  startPid: number,
  uid: number,
  ps: (args: readonly string[]) => string,
): readonly Ancestor[] {
  const table = parsePsTable(ps(["-Ao", "pid=,ppid=,uid="]));
  const chain: number[] = [];
  let pid = startPid;
  for (let depth = 0; depth < MAX_DEPTH && pid > 0; depth++) {
    const row = table.get(pid);
    if (row === undefined || row.uid !== uid) break;
    chain.push(pid);
    if (row.ppid <= 0 || row.ppid === pid) break;
    pid = row.ppid;
  }
  if (chain.length === 0) return [];

  const details = parsePsEnvirons(
    ps(["-E", "-ww", "-o", "pid=,command=", "-p", chain.join(",")]),
  );
  const ancestors: Ancestor[] = [];
  for (const p of chain) {
    const detail = details.get(p);
    if (detail === undefined) break; // environment withheld: chain ends here
    ancestors.push({ pid: p, uid, env: detail.env, argv: detail.argv });
  }
  return ancestors;
}

function parsePsTable(out: string): Map<number, { ppid: number; uid: number }> {
  const table = new Map<number, { ppid: number; uid: number }>();
  for (const line of out.split("\n")) {
    const [pid, ppid, uid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && Number.isInteger(pid) && ppid !== undefined) {
      table.set(pid, { ppid, uid: uid ?? -1 });
    }
  }
  return table;
}

/**
 * `ps -E` prints `pid argv… KEY=value…` with nothing marking where the
 * arguments stop and the environment starts, and values containing spaces are
 * split across tokens. So a KEY=-shaped token opens a variable and every plain
 * token after it extends that variable's value.
 *
 * The result is approximate in one direction — a `KEY=value` sitting in argv
 * is read as an environment entry — which the harness predicates tolerate:
 * they test for the presence of distinctive marker names, or compare against
 * short constants, never against a value that could carry a space.
 */
function parsePsEnvirons(
  out: string,
): Map<number, { argv: string[]; env: Env }> {
  const details = new Map<number, { argv: string[]; env: Env }>();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    const split = trimmed.indexOf(" ");
    if (split <= 0) continue;
    const pid = Number(trimmed.slice(0, split));
    if (!Number.isInteger(pid)) continue;

    const argv: string[] = [];
    const env: Record<string, string> = {};
    let key: string | undefined;
    for (const token of trimmed.slice(split + 1).split(" ")) {
      if (token === "") continue;
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
      if (assignment) {
        key = assignment[1] as string;
        env[key] = assignment[2] as string;
      } else if (key === undefined) {
        argv.push(token);
      } else {
        env[key] += ` ${token}`;
      }
    }
    details.set(pid, { argv, env });
  }
  return details;
}

/* ------------------------------------------------------------ verdict */

/**
 * How far up the process that introduced this harness's markers sits: the
 * nearest ancestor whose own environment does *not* carry them. `undefined`
 * means the markers come from outside the visible chain — a container or PID
 * namespace boundary, an ssh hop, or a permanently exported variable — which
 * makes the harness unattributable rather than defeated.
 */
export function hostIndex(
  matches: (env: Env) => boolean,
  ancestors: readonly Ancestor[],
): number | undefined {
  for (let i = 0; i < ancestors.length; i++) {
    const ancestor = ancestors[i] as Ancestor;
    if (!matches(ancestor.env)) return i;
  }
  return undefined;
}
