import { homedir } from "node:os";
import type { AgentContext, HarnessId } from "@todou/shared";
import type { Env } from "../config.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { hermesAgent } from "./hermes-agent.ts";
import { omp } from "./omp.ts";
import { publishedState } from "./omp-state.ts";
import { pi } from "./pi.ts";
import {
  type Ancestor,
  ancestorPids,
  hostIndex,
  openSessionLogs,
  type ProcessTreeIo,
  readAncestors,
} from "./process-tree.ts";
import type {
  Harness,
  HarnessContext,
  HostProcess,
  LiveSession,
} from "./types.ts";

/**
 * Every harness marks its whole process tree — claude code, codex and pi all
 * leak their markers into whatever they launch, and hermes stamps its own on
 * every child — so an environment carrying two of them says nothing about
 * which one is the direct host.
 *
 * The process tree answers that (T-128), and this order is only what decides
 * a case the tree cannot: no tree available, or two hosts at equal depth.
 * claude code leads because it is what drives this tracker.
 *
 * omp is the one exception, and it goes first: it sets `CLAUDECODE=1`
 * alongside its own marker, on purpose, so that tools keyed on Claude Code
 * behave inside it. Claude Code never sets `OMPCODE`, so one process holding
 * both markers is omp and nothing else — which is exactly the equal-depth tie
 * this order decides. Nested either way, the tree still arbitrates: an omp
 * started from Claude Code sits nearer than the claude that spawned it, and a
 * Claude Code started from omp sits nearer than the omp that spawned it
 * (T-109).
 */
export const HARNESSES = [
  omp,
  claudeCode,
  codex,
  pi,
  hermesAgent,
] as const satisfies readonly Harness[];

/**
 * How each harness is spelled in prose written for a reader, as opposed to
 * the id a matcher uses. A Record over the whole union, so a harness added to
 * HARNESS_IDS fails to compile until it has a label here — the same guard
 * HARNESS_META gives the web.
 */
export const HARNESS_LABELS: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "hermes-agent": "Hermes",
  omp: "omp",
  pi: "pi",
};

/**
 * The selected harness, and the pid to treat as its host when selection
 * already knows which ancestor that is. Absent means the marker boundary
 * decides it, as it always has.
 */
type Selection = { harness: Harness; hostPid?: number };

/**
 * The harness whose host process sits nearest to us, among those the
 * environment already matched — or, when it matched none, whichever one an
 * ancestor published a record naming.
 *
 * Both thunks stay unevaluated in the ordinary single-harness case, so the
 * common path still performs no I/O. The two that do cost something are a
 * genuine tie, which walks the tree, and no match at all, which lists one
 * directory and walks the tree only if that directory held anything — the
 * price of finding a harness whose runtimes carry none of its markers (T-313).
 */
function select(
  env: Env,
  ancestors: () => readonly Ancestor[],
  pids: () => readonly number[],
): Selection | null {
  const candidates = HARNESSES.filter((h) => h.matches(env));
  if (candidates.length === 0) return published(env, pids);
  if (candidates.length === 1) return { harness: candidates[0] as Harness };

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
  return { harness: best?.harness ?? (candidates[0] as Harness) };
}

/**
 * The second stage: a harness found not by a marker in our environment but by
 * a record an ancestor published naming itself.
 *
 * Reached only when the first stage put up no candidate at all, so it cannot
 * change what a matching environment selects. It exists because omp spawns its
 * eval runtimes without its own markers while they are still inside the same
 * session, and the state file is the only thing that says so (T-313) —
 * Python's runtime has no todou variable in its environment either, so the
 * process tree is the whole of the evidence there.
 *
 * `host` is pinned to the publisher rather than left to `hostIndex`: with no
 * marker anywhere in the chain that would stop at our immediate parent, which
 * on this path is the eval runtime and not the omp holding the session.
 */
function published(env: Env, pids: () => readonly number[]): Selection | null {
  const state = publishedState(env, pids);
  // A record with no `agent` names no harness to select; believing it would
  // mean guessing which one wrote a layout more than one may come to use.
  if (state?.agent === undefined) return null;
  const harness = HARNESSES.find((h) => h.id === state.agent);
  return harness ? { harness, hostPid: state.pid } : null;
}

/**
 * `host()` as both callers need it: resolved once, from the pid selection
 * pinned or the nearest ancestor that does not carry the harness's markers.
 * Shared because two copies of this drifted into two answers for the same
 * question once already.
 */
function hostResolver(
  selection: Selection,
  ancestors: () => readonly Ancestor[],
  io?: Partial<ProcessTreeIo>,
): () => HostProcess | undefined {
  let resolved = false;
  let host: HostProcess | undefined;
  return () => {
    if (resolved) return host;
    resolved = true;
    const found =
      selection.hostPid === undefined
        ? nearestUnmarked(selection.harness, ancestors())
        : ancestors().find((a) => a.pid === selection.hostPid);
    if (found) {
      host = {
        pid: found.pid,
        argv: found.argv,
        cwd: found.cwd,
        openLogs: openSessionLogs(io?.procRoot ?? "/proc", found.pid),
      };
    }
    return host;
  };
}

function nearestUnmarked(
  harness: Harness,
  chain: readonly Ancestor[],
): Ancestor | undefined {
  const depth = hostIndex((e) => harness.matches(e), chain);
  return depth === undefined ? undefined : chain[depth];
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
    let pidChain: readonly number[] | undefined;
    const pids = () => (pidChain ??= ancestorPids(io));
    const selection = select(env, ancestors, pids);
    if (selection === null) return null;

    return selection.harness.context({
      env,
      home,
      cwd,
      host: hostResolver(selection, ancestors, io),
      ancestorPids: pids,
    });
  } catch {
    return null;
  }
}

/**
 * A reader for the session id the harness holds *now*, rather than the
 * answer itself: the question is asked once per drain by anything resident
 * long enough for the answer to change, while which harness is answering it
 * cannot change at all (T-289).
 *
 * Selection and the process-tree walk therefore happen once, here; each
 * later call is one read of a small file, or — for a harness that publishes
 * no such thing — nothing at all.
 */
export function liveSessionIdReader(opts: {
  env: Env;
  home?: string;
  cwd?: string;
  io?: Partial<ProcessTreeIo>;
}): () => LiveSession {
  const nothing = () => ({});
  try {
    let chain: readonly Ancestor[] | undefined;
    const ancestors = () => (chain ??= readAncestors(opts.io));
    let pidChain: readonly number[] | undefined;
    const pids = () => (pidChain ??= ancestorPids(opts.io));
    const selection = select(opts.env, ancestors, pids);
    const probe = selection?.harness.liveSessionId;
    if (selection === null || probe === undefined) return nothing;
    const harness = selection.harness;

    const ctx: HarnessContext = {
      env: opts.env,
      home: opts.home ?? homedir(),
      cwd: opts.cwd ?? process.cwd(),
      host: hostResolver(selection, ancestors, opts.io),
      ancestorPids: pids,
    };
    return () => {
      try {
        return probe.call(harness, ctx);
      } catch {
        // Same contract as every other probe: less metadata, never an error.
        return {};
      }
    };
  } catch {
    return nothing;
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
  let pidChain: readonly number[] | undefined;
  return (
    select(
      env,
      () => (chain ??= readAncestors(io)),
      () => (pidChain ??= ancestorPids(io)),
    )?.harness.id ?? null
  );
}
