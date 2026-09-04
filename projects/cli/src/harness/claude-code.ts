import { globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import { findInJsonlTail } from "./jsonl-tail.ts";
import type { Harness } from "./types.ts";

export const claudeCode = {
  id: "claude-code",
  matches: (env) => env.CLAUDECODE === "1",
  context({ env, home }) {
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
  return fromTranscript(sessionId, home, modelFromLine);
}

/**
 * The permission mode a cross-session push may attest to (T-252), or
 * undefined when attesting would be a guess.
 *
 * Deliberately not part of `Harness.context()`: that runs on every command,
 * and only `watch --follow=uds` has any use for the mode.
 *
 * Guessing is worse than staying quiet in both directions. Without an
 * attestation a message is only held when the target is in bypass; with the
 * wrong one it is held outright as a mode mismatch. So `plan` — which the
 * receiver normalizes by a flag the transcript does not record — yields
 * nothing at all, and so does an unreadable transcript.
 */
export function detectPermissionMode(
  sessionId: string | undefined,
  home: string = homedir(),
): "bypass" | "prompting" | undefined {
  if (!sessionId) return undefined;
  const found = fromTranscript(sessionId, home, permissionModeFromLine);
  return found === AMBIGUOUS ? undefined : found;
}

function fromTranscript<T>(
  sessionId: string,
  home: string,
  pick: (line: string) => T | undefined,
): T | undefined {
  // The id comes from the environment: refuse anything path-shaped.
  if (!/^[0-9a-zA-Z-]+$/.test(sessionId)) return undefined;
  try {
    const file = globSync(
      join(home, ".claude", "projects", "*", `${sessionId}.jsonl`),
    )[0];
    if (!file) return undefined;
    return findInJsonlTail(file, pick);
  } catch {
    // Unreadable transcript is never an error.
    return undefined;
  }
}

/** Found a mode, and it is one we must not translate. Stops the scan. */
const AMBIGUOUS = Symbol("ambiguous permission mode");

/**
 * Unofficial format, same disclaimer as the model above: the mode rides
 * along on user entries and on a record of its own when it changes, so the
 * newest line carrying it is the live value — which is what keeps a mode the
 * user switched mid-session from being attested as the old one.
 */
function permissionModeFromLine(
  line: string,
): "bypass" | "prompting" | typeof AMBIGUOUS | undefined {
  if (!line.includes('"permissionMode"')) return undefined;
  try {
    const mode = (JSON.parse(line) as { permissionMode?: unknown })
      .permissionMode;
    if (mode === "bypassPermissions") return "bypass";
    if (mode === "default" || mode === "acceptEdits") return "prompting";
    // The newest record decides: scanning further back would attest a mode
    // that has since been left.
    if (mode === "plan") return AMBIGUOUS;
  } catch {
    // Half-written last line, a chunk-boundary fragment, or a foreign format.
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
