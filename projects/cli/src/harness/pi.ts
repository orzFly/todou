import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import { findInJsonlTail } from "./jsonl-tail.ts";
import {
  isSessionId,
  type OmpState,
  publishedStateAttempt,
  readOmpStateAt,
} from "./omp-state.ts";
import { type Ancestor, hostIndex } from "./process-tree.ts";
import { currentSessionFile, flagValue } from "./session-log.ts";
import type {
  Harness,
  HarnessContext,
  HostProcess,
  LiveSession,
} from "./types.ts";

/**
 * pi (earendil-works/pi) marks its children with `PI_CODING_AGENT=true`.
 * The todou extension publishes the current session; native pi also supplies
 * session and model variables to its bash tool. Older pi versions fall back
 * to their session logs.
 */
export const pi = {
  id: "pi",
  matches: (env) => env.PI_CODING_AGENT === "true",
  context(ctx) {
    const { env, home, cwd, host } = ctx;
    const context: AgentContext = { agent: "pi" };
    const here = resolve(cwd);
    const hostProcess = host();
    const state = piState(ctx);
    if (state) {
      context.session_id = state.sessionId;
      const model =
        (state.sessionFile
          ? findInJsonlTail(state.sessionFile, modelFromLine)
          : undefined) ??
        (env.PI_SESSION_ID === state.sessionId
          ? qualified(env.PI_PROVIDER, env.PI_MODEL)
          : undefined);
      if (model) context.model = model;
      return context;
    }
    // Native tool variables describe this invocation, not a re-readable live
    // source. Never mix them into a newer extension record's identity.
    const id = env.PI_SESSION_ID;
    if (id && isSessionId(id)) {
      context.session_id = id;
      const path = env.PI_SESSION_FILE;
      const model =
        qualified(env.PI_PROVIDER, env.PI_MODEL) ??
        (path && isAbsolute(path) && basename(path).endsWith(`_${id}.jsonl`)
          ? findInJsonlTail(path, modelFromLine)
          : undefined);
      if (model) context.model = model;
      return context;
    }
    const file = currentSessionFile({
      dirs: sessionDirs(env, home, here, hostProcess),
      cwd: here,
      hostCwd: hostProcess?.cwd ? resolve(hostProcess.cwd) : undefined,
      explicit: hostProcess && flagValue(hostProcess.argv, "--session"),
      // pi 0.85.1 appends with appendFileSync, which closes the descriptor.
      // Its readable descriptor table has no jsonl file, so `openLogs: []`
      // would incorrectly suppress this fallback.
    });
    if (!file) return context;
    context.session_id = file.id;
    const model = findInJsonlTail(file.path, modelFromLine);
    if (model) context.model = model;
    return context;
  },
  liveSessionId(ctx): LiveSession {
    const attempt = piStateAttempt(ctx);
    if (attempt.state) return { id: attempt.state.sessionId };
    return attempt.unreadable ? { unreadable: attempt.unreadable } : {};
  },
} satisfies Harness;

/**
 * A nested pi inherits its parent's marker, so argv supplies the inner boundary.
 * Only executable/script positions count; shell commands and arbitrary arguments
 * containing the word "pi" cannot claim a host.
 */
export function piHostAncestor(
  chain: readonly Ancestor[],
): Ancestor | undefined {
  const boundary = hostIndex((env) => env.PI_CODING_AGENT === "true", chain);
  for (const ancestor of chain) {
    const executable = basename(ancestor.argv[0] ?? "");
    if (executable === "pi") return ancestor;
    if (executable !== "node" && executable !== "bun") continue;
    const script = ancestor.argv[1] ?? "";
    if (
      basename(script) === "pi" ||
      /(?:^|[/\\])(?:pi[/\\]cli|pi-coding-agent[/\\]dist[/\\](?:bundle[/\\])?cli)\.[cm]?js$/.test(
        script,
      )
    ) {
      return ancestor;
    }
  }
  // No marker in the chain is the published-record-only path. Let its
  // publisher supply the host rather than treating an unmarked shell as pi.
  if (!chain.some((ancestor) => ancestor.env.PI_CODING_AGENT === "true")) {
    return undefined;
  }
  return boundary === undefined ? undefined : chain[boundary];
}

type StateContext = Pick<HarnessContext, "env" | "host" | "ancestorPids">;

/** The pi publisher belonging to this host, never an enclosing omp record. */
export function piState(ctx: StateContext): OmpState | undefined {
  return piStateAttempt(ctx).state;
}

function piStateAttempt({ env, host, ancestorPids }: StateContext): {
  state?: OmpState;
  unreadable?: string;
} {
  const hostProcess = host();
  const pids = () => {
    const chain = ancestorPids();
    if (!hostProcess) return chain;
    const boundary = chain.indexOf(hostProcess.pid);
    // A nearer publisher may be a nested pi which inherited the same marker.
    // The marker's host is an outer bound, not proof against that publisher.
    return boundary < 0 ? [hostProcess.pid] : chain.slice(0, boundary + 1);
  };
  const attempt = publishedStateAttempt(env, pids);
  if (attempt.state?.agent === "pi") return attempt;
  if (attempt.state) return {};
  const path = env.TODOU_PI_STATE;
  if (path) {
    const owners = pids();
    // Without a visible tree, an explicit pi record still works. With a host,
    // an inherited path beyond that boundary cannot name our session.
    if (
      owners.length === 0 ||
      owners.some((pid) => basename(path) === `${pid}.json`)
    ) {
      const state = readOmpStateAt(path);
      if (!state) return { unreadable: path };
      if (state.agent === "pi") return { state };
    }
  }
  return attempt.unreadable ? { unreadable: attempt.unreadable } : {};
}

/** pi's agent directory, shared by session discovery and installation. */
export function piAgentDir(
  env: Env,
  home: string,
): { dir: string; configRoot: string } {
  const configRoot = join(home, ".pi");
  const override = env.PI_CODING_AGENT_DIR;
  // Native pi expands both a bare `~` and a leading `~/`; other tildes are
  // literal path characters, not another user's home.
  const dir = override
    ? override === "~"
      ? home
      : override.startsWith("~/")
        ? join(home, override.slice(2))
        : override
    : join(configRoot, "agent");
  return { dir, configRoot };
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
  const { dir: agentDir } = piAgentDir(env, home);
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
