import { dirname, join, resolve } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import { findInJsonlTail } from "./jsonl-tail.ts";
import { currentSessionFile, flagValue } from "./session-log.ts";
import type { Harness, HostProcess } from "./types.ts";

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
    const here = resolve(cwd);
    const hostProcess = host();
    const file = currentSessionFile({
      dirs: sessionDirs(env, home, here, hostProcess),
      cwd: here,
      hostCwd: hostProcess?.cwd ? resolve(hostProcess.cwd) : undefined,
      explicit: hostProcess && flagValue(hostProcess.argv, "--session"),
    });
    if (!file) return context;
    context.session_id = file.id;
    const model = findInJsonlTail(file.path, modelFromLine);
    if (model) context.model = model;
    return context;
  },
} satisfies Harness;

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
