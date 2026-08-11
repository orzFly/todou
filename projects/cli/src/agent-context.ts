import { closeSync, globSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "./config.ts";

const TAIL_BYTES = 256 * 1024;

/**
 * Provenance of the invoking agent, currently detecting only Claude Code.
 * Detection must never break a command: every probe failure degrades to
 * "less metadata", not to an error.
 */
export function detectAgentContext(
  env: Env,
  home: string = homedir(),
): AgentContext | null {
  if (env.CLAUDECODE !== "1") return null;
  const context: AgentContext = { agent: "claude-code" };
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (sessionId) context.session_id = sessionId;
  const model = detectModel(env, sessionId, home);
  if (model) context.model = model;
  return context;
}

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
    // Unofficial format (Claude Code disclaims transcript stability):
    // newest assistant entry wins, everything unparseable is skipped.
    const lines = readTail(file, TAIL_BYTES).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] as string;
      if (!line.includes('"model"')) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: { model?: unknown };
        };
        if (
          entry.type === "assistant" &&
          typeof entry.message?.model === "string"
        ) {
          return entry.message.model;
        }
      } catch {
        // Truncated first line after the tail cut, or a foreign format.
      }
    }
  } catch {
    // Unreadable transcript is never an error.
  }
  return undefined;
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
