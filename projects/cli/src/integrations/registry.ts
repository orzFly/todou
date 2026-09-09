import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../config.ts";
import { ompAgentDir } from "../harness/omp.ts";
import { OMP_EXTENSION_SOURCE } from "./omp/extension.generated.ts";

/**
 * One agent this CLI can install itself into. Adding a second is adding a
 * record here and an asset beside it; nothing in `commands/integration.ts`
 * knows any agent by name.
 */
export type Integration = {
  /** What the user types, and what the installed file's marker line says. */
  id: string;
  /** How it is spelled in prose. */
  label: string;
  /**
   * Bumped when the asset changes in a way a reinstall must apply. It is
   * reported by `integration status`, so a stale install is visible without
   * diffing the file.
   */
  version: number;
  /**
   * Whether this agent looks installed on this machine.
   *
   * Deliberately *not* `Harness.matches`. That answers "is this command
   * running inside omp right now", which is a different question with a
   * different answer: `install-all` is typed into an ordinary shell, where
   * `matches` is false for every harness. Reusing it would make install-all
   * a command that can never install anything, reporting the plausible-
   * sounding lie that nothing is installed here.
   */
  tracesOnThisMachine(env: Env, home: string): boolean;
  /** The file `install` writes and `uninstall` removes. */
  targetPath(env: Env, home: string): string;
  /** The extension source, inlined at build time. */
  asset: string;
};

/** The file name we take inside the agent's own extensions directory. */
const OMP_FILE = "todou-omp-session.ts";

export const INTEGRATIONS: readonly Integration[] = [
  {
    id: "omp",
    label: "omp",
    version: 1,
    tracesOnThisMachine(env, home) {
      const { dir, configRoot } = ompAgentDir(env, home);
      // The config root counts too: a fresh omp that has been configured but
      // has not yet written a session has no `agent/` directory, and refusing
      // to install there would send the user to read this code to find out
      // why `install-all` skipped the agent they are looking at.
      return existsSync(dir) || existsSync(configRoot);
    },
    targetPath(env, home) {
      return join(ompAgentDir(env, home).dir, "extensions", OMP_FILE);
    },
    asset: OMP_EXTENSION_SOURCE,
  },
];

/** The record for one id, or undefined when nothing answers to that name. */
export function integration(id: string): Integration | undefined {
  return INTEGRATIONS.find((entry) => entry.id === id);
}

/**
 * The marker that says a file at the target path is ours to replace. Anything
 * else at that path belongs to the user or to another tool, and is refused
 * rather than overwritten — an extension directory is a place people put
 * their own files, and a lost one is not recoverable from here.
 */
export function marker(id: string): string {
  return `TODOU_INTEGRATION_ID=${id}`;
}

/**
 * What gets written: a header that says who owns the file and where to put
 * customizations, then the asset verbatim.
 */
export function render(entry: Integration): string {
  return [
    "// installed by todou",
    "// managed by todou; reinstalling or updating the integration overwrites this file.",
    "// add custom hooks/extensions beside this file instead of editing it.",
    `// ${marker(entry.id)}`,
    `// TODOU_INTEGRATION_VERSION=${entry.version}`,
    "",
    entry.asset,
  ].join("\n");
}
