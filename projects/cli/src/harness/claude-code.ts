import { closeSync, globSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import type { Harness } from "./types.ts";

const CHUNK_BYTES = 256 * 1024;
// A single image Read appends a ~400 KB base64 tool_result line, and the
// current turn's assistant entry is not always flushed yet (T-42) — so the
// newest assistant entry can sit megabytes behind EOF. 16 MB bounds the
// worst-case I/O per command.
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

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
    const size = statSync(file).size;
    const floor = Math.max(0, size - MAX_SCAN_BYTES);
    const fd = openSync(file, "r");
    try {
      let end = size;
      // Head fragment of a line that continues past the chunk boundary.
      // Kept as bytes: decoding per chunk would corrupt a multi-byte
      // character straddling the boundary.
      let carry: Buffer = Buffer.alloc(0);
      while (end > floor) {
        const start = Math.max(floor, end - CHUNK_BYTES);
        const chunk = readAt(fd, start, end - start);
        const window = carry.length ? Buffer.concat([chunk, carry]) : chunk;
        const firstNewline = window.indexOf(0x0a);
        if (firstNewline === -1) {
          // One line spans the whole window; keep accumulating backwards.
          carry = window;
        } else {
          const lines = window.toString("utf8", firstNewline + 1).split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const model = modelFromLine(lines[i] as string);
            if (model) return model;
          }
          carry = window.subarray(0, firstNewline);
        }
        end = start;
      }
      // Only at the true start of the file is the leftover fragment a
      // complete line; below the scan floor its beginning is missing.
      if (floor === 0) return modelFromLine(carry.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable transcript is never an error.
  }
  return undefined;
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

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const n = readSync(fd, buffer, filled, length - filled, position + filled);
    if (n === 0) break; // the file shrank underneath us
    filled += n;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}
