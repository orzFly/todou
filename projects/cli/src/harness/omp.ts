import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import { findInJsonlTail } from "./jsonl-tail.ts";
import { readOmpState } from "./omp-state.ts";
import { currentSessionFile, flagValue } from "./session-log.ts";
import type { Harness, HostProcess, LiveSession } from "./types.ts";

/**
 * omp, "Oh My Pi" (can1357/oh-my-pi), a fork of pi that kept pi's session
 * format and its `PI_*` variables while renaming everything user-facing.
 *
 * `OMPCODE=1` is the marker, set on the environment omp builds for its bash
 * tool. **omp sets `CLAUDECODE=1` there too**, deliberately, so that tools
 * keyed on Claude Code behave inside it — which means every omp shell also
 * satisfies the claude-code predicate, and the two are told apart by the
 * process tree and by this harness's place in the registry (see HARNESSES).
 * There is no `PI_CODING_AGENT` and no session or model variable: both are
 * recovered from the session log omp appends to as the turn runs — unless
 * the todou extension is installed, in which case omp publishes the session
 * itself and the scan becomes the fallback.
 */
export const omp = {
  id: "omp",
  matches: (env) => env.OMPCODE === "1",
  context({ env, home, cwd, host }) {
    const context: AgentContext = { agent: "omp" };
    // omp's own answer beats every heuristic below it, and costs one small
    // read where the scan costs a directory listing and a header read per
    // candidate. Anything wrong with the record falls through to the scan,
    // which is what an omp without the extension does anyway.
    const state = readOmpState(env);
    if (state) {
      context.session_id = state.sessionId;
      // The extension deliberately publishes no model: it changes every turn,
      // and the session log's tail already answers exactly — for the session
      // we now know for certain rather than the one recency guessed at.
      const live =
        state.sessionFile === undefined
          ? undefined
          : findInJsonlTail(state.sessionFile, modelFromLine);
      if (live) context.model = live;
      return context;
    }
    const here = resolve(cwd);
    const hostProcess = host();
    const hostCwd = hostProcess?.cwd ? resolve(hostProcess.cwd) : undefined;
    const file = currentSessionFile({
      dirs: sessionDirs(env, home, here, hostProcess),
      cwd: here,
      hostCwd,
      explicit: resumedFile(hostProcess),
    });
    if (!file) return context;
    context.session_id = file.id;
    const model = findInJsonlTail(file.path, modelFromLine);
    if (model) context.model = model;
    return context;
  },
  liveSessionId({ env }): LiveSession {
    const path = env.TODOU_OMP_STATE;
    // Nothing published: the extension is not installed, and there is no
    // re-readable answer to have failed at. Silence is the whole report.
    if (path === undefined) return {};
    const state = readOmpState(env);
    // Named a file and then could not believe it — the one case worth saying
    // out loud, because falling back quietly restores exactly the startup
    // snapshot this probe exists to replace (T-289).
    return state ? { id: state.sessionId } : { unreadable: path };
  },
} satisfies Harness;

/**
 * The session file `--resume` was handed, when it was handed one at all: the
 * same flag also takes a bare session-id prefix and opens a picker, and only
 * a path can be read as a file. `--session` is an alias of it, kept from pi.
 */
function resumedFile(host: HostProcess | undefined): string | undefined {
  if (!host) return undefined;
  for (const flag of ["--resume", "-r", "--session"]) {
    const value = flagValue(host.argv, flag);
    if (value?.endsWith(".jsonl")) return value;
  }
  return undefined;
}

/**
 * Where omp could be keeping this project's sessions. The per-project
 * directory name encodes omp's own cwd, and a tool may well run us from a
 * subdirectory of it, so every ancestor is a candidate.
 */
function sessionDirs(
  env: Env,
  home: string,
  cwd: string,
  host: HostProcess | undefined,
): string[] {
  // The flag beats the variable: it is the more specific, per-invocation
  // choice, and being a command-line argument it is invisible from the
  // environment — which is what cost pi its session under this mode (T-108).
  //
  // `||`, not `??`: omp reads its own variables for truthiness, so a
  // bound-but-empty value means "unset" to omp and must mean the same here
  // (T-120). The same holds for every variable read below.
  const flat =
    (host && flagValue(host.argv, "--session-dir")) ||
    env.PI_CODING_AGENT_SESSION_DIR;
  // A flat session directory overrides the per-project layout entirely,
  // pointing every project at one directory rather than a subdirectory of it.
  if (flat) return [flat];

  const dirs: string[] = [];
  // omp's own cwd is what the directory name encodes, so the host answers
  // directly what walking our ancestors can only guess at. Both are kept:
  // /proc resolves symlinks while omp records the logical path it was given,
  // and the two can disagree.
  const roots: string[] = host?.cwd ? [resolve(host.cwd)] : [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    roots.push(dir);
    if (dirname(dir) === dir) break;
  }
  for (const sessions of sessionRoots(env, home)) {
    for (const root of roots) {
      const dir = join(sessions, sessionDirName(root, home, tmpDir(env)));
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Where omp keeps this user's agent directory — the one holding `sessions/`
 * and `extensions/`, which is what `todou integration install omp` writes
 * into (T-308).
 *
 * Four things can move it, and getting any of them wrong is an integration
 * that installs successfully into a directory omp never reads. It is resolved
 * once, here, rather than in both the detector and the installer: two copies
 * would drift, and drift shows up as "installed, and nothing happened".
 */
export function ompAgentDir(
  env: Env,
  home: string,
): { dir: string; configRoot: string; profile?: string; relocated: boolean } {
  const configRoot = join(home, env.PI_CONFIG_DIR || ".omp");
  const profile = ompProfile(env);
  // A profile *discards* `PI_CODING_AGENT_DIR` rather than losing to it: omp
  // drops the override twice over, once where it reads the variable and again
  // inside the object that resolves the directory, so an override set beside a
  // profile reaches nothing. Measured on omp 18.1.15 — with both set, the
  // session lands under the profile's directory and the override's is never
  // created.
  //
  // Inside omp the two orders agree, because omp overwrites
  // `PI_CODING_AGENT_DIR` with whatever the profile resolved to before its
  // tools inherit the environment. They part company in the ordinary shell
  // where `todou integration install omp` runs, and getting it backwards there
  // is precisely the "installs into a directory omp never reads" this
  // function's contract warns about.
  const dir = profile
    ? join(configRoot, "profiles", profile, "agent")
    : env.PI_CODING_AGENT_DIR || join(configRoot, "agent");
  return {
    dir,
    configRoot,
    ...(profile ? { profile } : {}),
    // Only an override with no profile to overrule it moves the directory off
    // omp's own layout, which is the condition omp itself puts on the XDG
    // split below.
    relocated: !profile && !!env.PI_CODING_AGENT_DIR,
  };
}

/**
 * The active profile, or nothing.
 *
 * `??`, not the `||` every other variable in this file is read with: omp
 * chooses between these two with an explicit undefined check, so a
 * bound-but-empty `OMP_PROFILE` shadows `PI_PROFILE` instead of falling
 * through to it — and then fails omp's own profile-name validation, leaving no
 * profile at all. Measured: `OMP_PROFILE= PI_PROFILE=x` files the session under
 * the default agent directory, and omp deletes both variables from the
 * environment its tools inherit.
 */
function ompProfile(env: Env): string | undefined {
  const named = env.OMP_PROFILE ?? env.PI_PROFILE;
  return named ? named : undefined;
}

/**
 * The `sessions` directories omp may be writing to, in the order it prefers
 * them. Both are offered rather than resolved, because choosing between them
 * is an `existsSync` on omp's side and a `readdirSync` that finds nothing on
 * ours — the same answer for one syscall instead of two.
 */
function sessionRoots(env: Env, home: string): string[] {
  const { dir, profile, relocated } = ompAgentDir(env, home);
  const roots: string[] = [];
  // The XDG split applies only while the agent directory sits where omp put
  // it: an explicitly relocated one takes its data with it.
  if (!relocated && env.XDG_DATA_HOME) {
    const xdg = join(env.XDG_DATA_HOME, "omp");
    roots.push(
      join(profile ? join(xdg, "profiles", profile) : xdg, "sessions"),
    );
  }
  roots.push(join(dir, "sessions"));
  return roots;
}

/**
 * omp's own encoding of a cwd into one directory name: relative to the home
 * directory or to the temporary directory when it sits under either, and pi's
 * absolute form otherwise. The result is ambiguous by construction — `~/tmp`
 * and `/tmp` both encode to `-tmp` — which costs nothing here, because the
 * session's own header decides whether a candidate is ours.
 */
function sessionDirName(cwd: string, home: string, tmp: string): string {
  const fromHome = relative(home, cwd);
  if (under(fromHome)) return prefixed("-", fromHome);
  const fromTmp = relative(tmp, cwd);
  if (under(fromTmp)) return prefixed("-tmp", fromTmp);
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function under(rel: string): boolean {
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function prefixed(prefix: string, rel: string): string {
  const tail = rel.replace(/[/\\:]/g, "-");
  if (!tail) return prefix;
  return prefix.endsWith("-") ? `${prefix}${tail}` : `${prefix}-${tail}`;
}

/**
 * The temporary directory as omp's runtime resolves it, read from the
 * environment we were handed rather than from `os.tmpdir()`, so that the
 * whole detector stays a function of its injected context.
 */
function tmpDir(env: Env): string {
  const named = env.TMPDIR || env.TMP || env.TEMP;
  if (!named) return "/tmp";
  return named.length > 1 ? named.replace(/[/\\]$/, "") : named;
}

/**
 * omp resolves the live model by replaying the session and keeping the last
 * `model_change` or assistant message, whichever came later — so the newest
 * of either in the file is the answer. Unlike pi's, omp's `model_change`
 * already spells the provider into one string, the way `--model provider/id`
 * does, because one id can be served by several providers.
 *
 * The entry's `role` is deliberately not filtered on: every call site sets
 * the active model in the same breath as recording the change, so a
 * role-tagged or `fallback` entry is still what answered next.
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
      model?: unknown;
      message?: { role?: string; provider?: unknown; model?: unknown };
    };
    if (entry.type === "model_change") {
      return typeof entry.model === "string" && entry.model !== ""
        ? entry.model
        : undefined;
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
