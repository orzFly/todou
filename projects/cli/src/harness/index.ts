import { homedir } from "node:os";
import type { AgentContext, HarnessId } from "@todou/shared";
import type { Env } from "../config.ts";
import { claudeCode } from "./claude-code.ts";
import { hermesAgent } from "./hermes-agent.ts";
import type { Harness } from "./types.ts";

/**
 * Ordered innermost-first: a harness whose environment is inherited by the
 * agents it spawns must come after the harnesses it can spawn, so the
 * nearest host wins when several signals are present at once. A hermes
 * terminal turn can launch claude code, which passes HERMES_SESSION_* on
 * to its children — CLAUDECODE=1 then marks the direct host.
 */
export const HARNESSES = [
  claudeCode,
  hermesAgent,
] as const satisfies readonly Harness[];

/**
 * Provenance of the invoking agent harness. Detection must never break a
 * command: every probe failure degrades to "less metadata", not to an error.
 */
export function detectAgentContext(
  env: Env,
  home: string = homedir(),
): AgentContext | null {
  try {
    return HARNESSES.find((h) => h.matches(env))?.context(env, home) ?? null;
  } catch {
    return null;
  }
}

/** The matching harness id alone — a pure env predicate, zero I/O. */
export function detectHarnessId(env: Env): HarnessId | null {
  return HARNESSES.find((h) => h.matches(env))?.id ?? null;
}
