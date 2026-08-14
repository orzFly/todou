import { homedir } from "node:os";
import type { AgentContext, HarnessId } from "@todou/shared";
import type { Env } from "../config.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { hermesAgent } from "./hermes-agent.ts";
import { pi } from "./pi.ts";
import {
  type Ancestor,
  hostIndex,
  type ProcessTreeIo,
  readAncestors,
} from "./process-tree.ts";
import type { Harness, HostProcess } from "./types.ts";

/**
 * Every harness marks its whole process tree — claude code, codex and pi all
 * leak their markers into whatever they launch, and hermes stamps its own on
 * every child — so an environment carrying two of them says nothing about
 * which one is the direct host.
 *
 * The process tree answers that (T-128), and this order is only what decides
 * a case the tree cannot: no tree available, or two hosts at equal depth.
 * claude code leads because it is what drives this tracker.
 */
export const HARNESSES = [
  claudeCode,
  codex,
  pi,
  hermesAgent,
] as const satisfies readonly Harness[];

/**
 * The harness whose host process sits nearest to us, among those the
 * environment already matched.
 *
 * `ancestors` is a thunk and stays unevaluated unless two harnesses actually
 * tie: outside a harness, and in the ordinary single-harness case, detection
 * performs no I/O at all.
 */
function select(
  env: Env,
  ancestors: () => readonly Ancestor[],
): Harness | null {
  const candidates = HARNESSES.filter((h) => h.matches(env));
  if (candidates.length <= 1) return candidates[0] ?? null;

  const chain = ancestors();
  let best: { harness: Harness; depth: number } | undefined;
  for (const harness of candidates) {
    const depth = hostIndex((e) => harness.matches(e), chain);
    // Strictly nearer, so an equal depth leaves the registry order in charge.
    if (depth !== undefined && (best === undefined || depth < best.depth)) {
      best = { harness, depth };
    }
  }
  // Nothing attributable — markers introduced outside the visible chain.
  return best?.harness ?? (candidates[0] as Harness);
}

/**
 * Provenance of the invoking agent harness. Detection must never break a
 * command: every probe failure degrades to "less metadata", not to an error.
 */
export function detectAgentContext(
  env: Env,
  home: string = homedir(),
  cwd: string = process.cwd(),
  io?: Partial<ProcessTreeIo>,
): AgentContext | null {
  try {
    let chain: readonly Ancestor[] | undefined;
    const ancestors = () => (chain ??= readAncestors(io));
    const harness = select(env, ancestors);
    if (harness === null) return null;

    let resolved = false;
    let host: HostProcess | undefined;
    return harness.context({
      env,
      home,
      cwd,
      host: () => {
        if (!resolved) {
          resolved = true;
          const depth = hostIndex((e) => harness.matches(e), ancestors());
          const found = depth === undefined ? undefined : ancestors()[depth];
          if (found) {
            host = { pid: found.pid, argv: found.argv, cwd: found.cwd };
          }
        }
        return host;
      },
    });
  } catch {
    return null;
  }
}

/**
 * The matching harness id alone. Zero I/O unless two harnesses signal at
 * once — which is what keeps it usable on the token-selection path, where it
 * runs for every command.
 */
export function detectHarnessId(
  env: Env,
  io?: Partial<ProcessTreeIo>,
): HarnessId | null {
  let chain: readonly Ancestor[] | undefined;
  return select(env, () => (chain ??= readAncestors(io)))?.id ?? null;
}
