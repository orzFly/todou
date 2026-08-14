import { globSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import { findInJsonlTail } from "./jsonl-tail.ts";
import type { Harness } from "./types.ts";

export const claudeCode = {
  id: "claude-code",
  matches: (env) => env.CLAUDECODE === "1",
  context(env, home) {
    const context: AgentContext = { agent: "claude-code" };
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    if (sessionId) context.session_id = sessionId;
    const model = detectModel(env, sessionId, home);
    if (model) context.model = model;
    return context;
  },
} satisfies Harness;

/**
 * The transcript tail wins over CLAUDE_MODEL: a SessionStart-hook snapshot
 * goes stale when the user switches models mid-session, while the last
 * assistant entry always reflects the model that actually responded.
 */
export function detectModel(
  env: Env,
  sessionId: string | undefined,
  home: string,
): string | undefined {
  if (sessionId) {
    const fromTranscript = modelFromTranscript(sessionId, home);
    if (fromTranscript) return fromTranscript;
  }
  return env.CLAUDE_MODEL || undefined;
}

function modelFromTranscript(
  sessionId: string,
  home: string,
): string | undefined {
  // The id comes from the environment: refuse anything path-shaped.
  if (!/^[0-9a-zA-Z-]+$/.test(sessionId)) return undefined;
  try {
    const file = globSync(
      join(home, ".claude", "projects", "*", `${sessionId}.jsonl`),
    )[0];
    if (!file) return undefined;
    return findInJsonlTail(file, modelFromLine);
  } catch {
    // Unreadable transcript is never an error.
    return undefined;
  }
}

/**
 * Unofficial format (Claude Code disclaims transcript stability): the
 * newest assistant entry wins, everything unparseable is skipped.
 */
function modelFromLine(line: string): string | undefined {
  if (!line.includes('"model"')) return undefined;
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { model?: unknown };
    };
    if (
      entry.type === "assistant" &&
      typeof entry.message?.model === "string" &&
      // API-error turns log a placeholder entry with model "<synthetic>" —
      // an angle-bracketed value is never a real model id (T-42).
      !entry.message.model.startsWith("<")
    ) {
      return entry.message.model;
    }
  } catch {
    // Half-written last line, a chunk-boundary fragment, or a foreign format.
  }
  return undefined;
}
