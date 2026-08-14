import type { HarnessId } from "@todou/shared";
import type { ComponentType, SVGProps } from "react";
import { ClaudeMark, HermesMark } from "./harness-logos.tsx";

export type HarnessMeta = {
  logo: ComponentType<SVGProps<SVGSVGElement>>;
  /**
   * Builds the copy-on-click shell command for a session badge. A harness
   * that cannot resume from the id it reports (hermes routes sessions by
   * chat) omits this, and the badge copies the session id itself.
   */
  resume?: (sessionId: string) => string;
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
    resume: (sessionId) => `claude --resume ${sessionId}`,
  },
  "hermes-agent": { logo: HermesMark },
};

/** Any client may report any agent string; unknown ones simply have no meta. */
export function harnessMeta(agent: string): HarnessMeta | undefined {
  return Object.hasOwn(HARNESS_META, agent)
    ? HARNESS_META[agent as HarnessId]
    : undefined;
}
