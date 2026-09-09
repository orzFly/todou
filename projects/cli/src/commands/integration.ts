import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Command, Option } from "clipanion";
import type { CliContext } from "../api-command.ts";
import { type Env, tildePath } from "../config.ts";
import { CliError, reportError } from "../errors.ts";
import {
  INTEGRATIONS,
  type Integration,
  integration,
  marker,
  render,
} from "../integrations/registry.ts";

/** What one agent's install or uninstall came to, in one line for the user. */
type Outcome = { line: string; failed?: true };

/** Reads the installed file, or null when there is nothing at that path. */
function installed(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The version the file at the target path says it was installed at. */
function installedVersion(text: string): string | undefined {
  return /TODOU_INTEGRATION_VERSION=(\d+)/.exec(text)?.[1];
}

/**
 * The one thing this refuses to do. An extensions directory is where people
 * put their own files and where another tool's installer writes too, so a
 * file without our marker is somebody else's and is never overwritten or
 * deleted — the alternative silently destroys work with no way back.
 */
function foreign(text: string | null, entry: Integration): boolean {
  return text !== null && !text.includes(marker(entry.id));
}

function install(
  entry: Integration,
  env: Env,
  home: string,
  dryRun: boolean,
): Outcome {
  const path = entry.targetPath(env, home);
  const shown = tildePath(path, env);
  const existing = installed(path);
  if (foreign(existing, entry)) {
    return {
      line: `${entry.id}: refused — ${shown} was not written by todou; move it aside first`,
      failed: true,
    };
  }
  const was = existing === null ? undefined : installedVersion(existing);
  const what =
    existing === null
      ? `install v${entry.version}`
      : was === String(entry.version)
        ? `reinstall v${entry.version}`
        : `replace v${was ?? "?"} with v${entry.version}`;
  if (dryRun) return { line: `${entry.id}: would ${what} at ${shown}` };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, render(entry));
  } catch (error) {
    return {
      line: `${entry.id}: failed to write ${shown} — ${(error as Error).message}`,
      failed: true,
    };
  }
  // Said on every install, because an installed extension does nothing until
  // the agent next starts, and an agent that looks unchanged is the first
  // thing anyone reports.
  return {
    line: `${entry.id}: ${what} at ${shown} — takes effect the next time ${entry.label} starts`,
  };
}

function uninstall(
  entry: Integration,
  env: Env,
  home: string,
  dryRun: boolean,
): Outcome {
  const path = entry.targetPath(env, home);
  const shown = tildePath(path, env);
  const existing = installed(path);
  if (existing === null) return { line: `${entry.id}: nothing at ${shown}` };
  if (foreign(existing, entry)) {
    return {
      line: `${entry.id}: refused — ${shown} was not written by todou`,
      failed: true,
    };
  }
  if (dryRun) return { line: `${entry.id}: would remove ${shown}` };
  try {
    rmSync(path, { force: true });
  } catch (error) {
    return {
      line: `${entry.id}: failed to remove ${shown} — ${(error as Error).message}`,
      failed: true,
    };
  }
  return { line: `${entry.id}: removed ${shown}` };
}

function status(entry: Integration, env: Env, home: string): Outcome {
  const path = entry.targetPath(env, home);
  const shown = tildePath(path, env);
  const existing = installed(path);
  const present = entry.tracesOnThisMachine(env, home)
    ? ""
    : " (no sign of this agent on this machine)";
  if (existing === null) {
    return { line: `${entry.id}: not installed · ${shown}${present}` };
  }
  if (foreign(existing, entry)) {
    return { line: `${entry.id}: a file todou did not write · ${shown}` };
  }
  const was = installedVersion(existing);
  const state =
    was === String(entry.version)
      ? `installed v${entry.version}`
      : `installed v${was ?? "?"}, current is v${entry.version} — reinstall`;
  return { line: `${entry.id}: ${state} · ${shown}` };
}

/** Resolves the ids a user typed, refusing an unknown one before any write. */
function selected(ids: readonly string[]): Integration[] {
  const known = INTEGRATIONS.map((entry) => entry.id).join(", ");
  return ids.map((id) => {
    const entry = integration(id);
    if (!entry) {
      throw new CliError(`unknown integration "${id}"`, `known: ${known}`);
    }
    return entry;
  });
}

/**
 * The shared body of all five commands: run one action per agent, print every
 * line, and exit 1 if any of them failed.
 *
 * Nothing is rolled back. Two agents are two machines' worth of independent
 * state, and undoing a good install because a second one hit a permission
 * error would throw away the part that worked — so the report names each
 * outcome separately and the user acts on the ones that did not.
 */
abstract class IntegrationCommand extends Command<CliContext> {
  protected report(outcomes: Outcome[]): number {
    for (const outcome of outcomes) {
      this.context.stdout.write(`${outcome.line}\n`);
    }
    return outcomes.some((outcome) => outcome.failed) ? 1 : 0;
  }

  protected get home(): string {
    return this.context.home ?? homedir();
  }

  /** Every agent this machine shows a sign of, for the `-all` commands. */
  protected traced(): Integration[] {
    return INTEGRATIONS.filter((entry) =>
      entry.tracesOnThisMachine(this.context.env, this.home),
    );
  }
}

const DRY_RUN = {
  description: "Print what would change and write nothing",
};

const WHAT_IT_INSTALLS =
  "The extension teaches the agent to publish which session it is in, so " +
  "that `todou` stops inferring it from session-log timestamps — which two " +
  "instances open on one project defeat by construction. It also gives the " +
  "session somewhere for `todou watch --follow=uds` to push to.\n\n" +
  "It is per-user, not per-project: the file lands in the agent's own " +
  "directory under $HOME, and an agent without it keeps working exactly as " +
  "before, inferring the session as it always did.";

export class IntegrationInstallCommand extends IntegrationCommand {
  static paths = [["integration", "install"]];
  static usage = Command.Usage({
    description: "Install the todou extension into an agent",
    details:
      `${WHAT_IT_INSTALLS}\n\n` +
      "A file already at the target path is replaced only when todou wrote " +
      "it; anything else is refused and named, because an extensions " +
      "directory is where people keep their own files.\n\n" +
      "The change takes effect the next time the agent starts.",
    examples: [["Install into omp", "$0 integration install omp"]],
  });

  agents = Option.Rest({ required: 1 });
  dryRun = Option.Boolean("--dry-run", false, DRY_RUN);

  async execute(): Promise<number | undefined> {
    try {
      const entries = selected(this.agents);
      return this.report(
        entries.map((entry) =>
          install(entry, this.context.env, this.home, this.dryRun),
        ),
      );
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}

export class IntegrationUninstallCommand extends IntegrationCommand {
  static paths = [["integration", "uninstall"]];
  static usage = Command.Usage({
    description: "Remove the todou extension from an agent",
    details:
      "Removes only a file todou wrote — one it did not is refused and " +
      "named. The agent goes back to inferring its session from session-log " +
      "timestamps, and `--follow=uds` stops being available to it.",
    examples: [["Remove it from omp", "$0 integration uninstall omp"]],
  });

  agents = Option.Rest({ required: 1 });
  dryRun = Option.Boolean("--dry-run", false, DRY_RUN);

  async execute(): Promise<number | undefined> {
    try {
      const entries = selected(this.agents);
      return this.report(
        entries.map((entry) =>
          uninstall(entry, this.context.env, this.home, this.dryRun),
        ),
      );
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}

export class IntegrationStatusCommand extends IntegrationCommand {
  static paths = [["integration", "status"]];
  static usage = Command.Usage({
    description: "Report which agents todou is installed into",
    details:
      "With no agent named, every integration todou knows about. Reads " +
      "files only — no server, no token — so it answers while the tracker " +
      "is down.",
    examples: [
      ["Every integration", "$0 integration status"],
      ["Just omp", "$0 integration status omp"],
    ],
  });

  agents = Option.Rest();

  async execute(): Promise<number | undefined> {
    try {
      const entries =
        this.agents.length === 0 ? [...INTEGRATIONS] : selected(this.agents);
      return this.report(
        entries.map((entry) => status(entry, this.context.env, this.home)),
      );
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}

export class IntegrationInstallAllCommand extends IntegrationCommand {
  static paths = [["integration", "install-all"]];
  static usage = Command.Usage({
    description: "Install the todou extension into every agent found here",
    details:
      `${WHAT_IT_INSTALLS}\n\n` +
      "Every agent this machine shows a sign of, which is a question about " +
      "the filesystem and not about what this command is running inside: it " +
      "is meant to be typed into an ordinary shell, where no agent is " +
      "present in the environment at all.\n\n" +
      "Finding none is success, not a failure.",
    examples: [["Set up this machine", "$0 integration install-all"]],
  });

  dryRun = Option.Boolean("--dry-run", false, DRY_RUN);

  async execute(): Promise<number | undefined> {
    try {
      const entries = this.traced();
      if (entries.length === 0) {
        this.context.stdout.write("no agent found on this machine\n");
        return 0;
      }
      return this.report(
        entries.map((entry) =>
          install(entry, this.context.env, this.home, this.dryRun),
        ),
      );
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}

export class IntegrationUninstallAllCommand extends IntegrationCommand {
  static paths = [["integration", "uninstall-all"]];
  static usage = Command.Usage({
    description: "Remove the todou extension from every agent found here",
    details:
      "The counterpart to `integration install-all`, over the same set: " +
      "every agent this machine shows a sign of. Files todou did not write " +
      "are left alone and named.",
    examples: [["Undo it everywhere", "$0 integration uninstall-all"]],
  });

  dryRun = Option.Boolean("--dry-run", false, DRY_RUN);

  async execute(): Promise<number | undefined> {
    try {
      const entries = this.traced();
      if (entries.length === 0) {
        this.context.stdout.write("no agent found on this machine\n");
        return 0;
      }
      return this.report(
        entries.map((entry) =>
          uninstall(entry, this.context.env, this.home, this.dryRun),
        ),
      );
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}
