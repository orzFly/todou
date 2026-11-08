import type { HarnessId } from "@todou/shared";
import type { ComponentType, SVGProps } from "react";
import {
  ClaudeMark,
  CodexMark,
  HermesMark,
  OmpMark,
  PiMark,
} from "./harness-logos.tsx";

/**
 * Props a harness mark accepts. svgr's `?react` components take `title` on top
 * of the usual svg props, and the badge passes `title=""` to drop the brand
 * <title> the upstream files ship with; a mark vendored by hand simply ignores
 * it, since `title` is optional here.
 */
export type HarnessMarkProps = SVGProps<SVGSVGElement> & { title?: string };

export type HarnessMeta = {
  logo: ComponentType<HarnessMarkProps>;
  /**
   * Builds the copy-on-click shell command for a session badge. Optional
   * because a harness need not be resumable from the id it reports; the
   * badge then copies the bare session id, which is also what any agent
   * string outside this registry gets. It receives the id already quoted
   * for the shell; build the command through `sessionCopy`, never directly.
   */
  resume?: (sessionWord: string) => string;
};

/**
 * Per-harness display metadata, keyed by AgentContext.agent. `logo` is
 * required, and the Record spans the whole HarnessId union: a harness added
 * to the shared list fails to compile until it has a mark here, so the badge
 * can never quietly fall back to the generic bot for a harness todou itself
 * supports.
 */
export const HARNESS_META: Record<HarnessId, HarnessMeta> = {
  "claude-code": {
    logo: ClaudeMark,
    resume: (sessionWord) => `claude --resume ${sessionWord}`,
  },
  codex: {
    logo: CodexMark,
    resume: (sessionWord) => `codex resume ${sessionWord}`,
  },
  "hermes-agent": {
    logo: HermesMark,
    resume: (sessionWord) => `hermes --resume ${sessionWord}`,
  },
  omp: {
    logo: OmpMark,
    resume: (sessionWord) => `omp --resume ${sessionWord}`,
  },
  pi: { logo: PiMark, resume: (sessionWord) => `pi --session ${sessionWord}` },
};

/** Any client may report any agent string; unknown ones simply have no meta. */
export function harnessMeta(agent: string): HarnessMeta | undefined {
  return Object.hasOwn(HARNESS_META, agent)
    ? HARNESS_META[agent as HarnessId]
    : undefined;
}

const SHELL_SAFE = /^[A-Za-z0-9._:@%+=,/-]+$/;
// Without bracketed paste a terminal types these as keystrokes, and a line
// editor acts on them (^U kills the line, ^M runs it) wherever the shell's
// quotes stand; format characters can hide text in the toast.
const UNCOPYABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * What a session badge copies, or null when it copies nothing. The session
 * id is whatever the writer's client reported (T-645), and the copy is
 * meant to be pasted into a shell: an id outside the characters real
 * harness ids use is single-quoted so it stays one argument.
 */
export function sessionCopy(
  agent: string,
  sessionId: string,
): { text: string; label: string } | null {
  if (UNCOPYABLE.test(sessionId)) return null;
  const word = SHELL_SAFE.test(sessionId)
    ? sessionId
    : `'${sessionId.replaceAll("'", `'\\''`)}'`;
  const resume = harnessMeta(agent)?.resume;
  return resume
    ? { text: resume(word), label: "the resume command" }
    : { text: word, label: "the session id" };
}
