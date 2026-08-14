import { globSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import { findInJsonlTail } from "./jsonl-tail.ts";
import type { Harness } from "./types.ts";

/**
 * OpenAI Codex (openai/codex). `CODEX_THREAD_ID` is the only marker every
 * codex-spawned shell carries: the shell tool, the unified-exec tool and the
 * TUI's `!` escape all inject it, and it survives an `include_only`
 * shell-environment policy because codex re-inserts it afterwards. The other
 * `CODEX_*` variables are unusable as signals — `CODEX_SESSION_ID` postdates
 * 0.146.0 and is absent from the exec path, `CODEX_SANDBOX_*` appear only
 * under specific sandbox settings, and codex documents
 * `CODEX_PERMISSION_PROFILE` as overwritable by child processes.
 *
 * The thread id doubles as the durable chat identity: it names the rollout
 * transcript and is the argument `codex resume` takes.
 */
export const codex = {
  id: "codex",
  matches: (env) => Boolean(env.CODEX_THREAD_ID),
  context({ env, home }) {
    const context: AgentContext = { agent: "codex" };
    const threadId = env.CODEX_THREAD_ID;
    if (threadId) context.session_id = threadId;
    const rollout = rolloutFile(env, threadId, home);
    const model = rollout ? findInJsonlTail(rollout, modelFromLine) : undefined;
    if (model) context.model = model;
    return context;
  },
} satisfies Harness;

/**
 * The thread's rollout transcript, which is the only place the live model
 * appears: codex publishes no model variable, and both the session header and
 * `config.toml` keep reporting the model the thread started with.
 */
function rolloutFile(
  env: Env,
  threadId: string | undefined,
  home: string,
): string | undefined {
  if (!threadId) return undefined;
  // The id comes from the environment: refuse anything path-shaped.
  if (!/^[0-9a-zA-Z-]+$/.test(threadId)) return undefined;
  // `||`, not `??`: a shell that exports CODEX_HOME empty would otherwise
  // count as having chosen a home, and the glob would run from the filesystem
  // root instead of the real default (T-120).
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  try {
    // Rollouts are filed under sessions/YYYY/MM/DD/, one per thread — a
    // resumed thread appends to its file rather than opening a new one.
    return globSync(
      join(codexHome, "sessions", "*", "*", "*", `rollout-*-${threadId}.jsonl`),
    )[0];
  } catch {
    // An unreadable sessions tree is never an error.
    return undefined;
  }
}

/**
 * Codex records a `turn_context` per turn, so the newest one is the model that
 * is about to answer — including after a mid-session `/model` switch. Foreign
 * and unparseable lines are skipped, and a thread with no turn yet simply
 * yields no model.
 */
function modelFromLine(line: string): string | undefined {
  if (!line.includes('"turn_context"')) return undefined;
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      payload?: { model?: unknown };
    };
    if (
      entry.type === "turn_context" &&
      typeof entry.payload?.model === "string" &&
      entry.payload.model !== ""
    ) {
      return entry.payload.model;
    }
  } catch {
    // Half-written last line, a chunk-boundary fragment, or a foreign format.
  }
  return undefined;
}
