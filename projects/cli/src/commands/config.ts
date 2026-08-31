import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import { resolveVersion } from "@todou/shared/version";
import { Command, Option } from "clipanion";
import type { CliContext } from "../api-command.ts";
import type { CliConfig, Env } from "../config.ts";
import { configPath, loadCliConfig } from "../config.ts";
import type {
  ProjectSource,
  ResolvedContext,
  ServerSource,
  TokenSource,
} from "../context.ts";
import { gitRemoteUrl, resolveContext } from "../context.ts";
import { discoverDirConfig, displayPath } from "../dir-config.ts";
import { reportError } from "../errors.ts";

/**
 * Everything `config show` is allowed to know — and the whole of T-185's
 * hard constraint, expressed as a type rather than as a redaction pass.
 *
 * There is deliberately no field a token value could be assigned to: not a
 * masked one, not a suffix, not a hash. `ServerEntry.token` / `.tokens` and
 * `ResolvedContext.token` are read exactly once, in `buildConfigReport`,
 * and only ever collapse to `default_token: boolean` and a list of profile
 * *names*. Both renderers below read this object and nothing else, so a
 * leak would have to start by widening this type — which is a reviewable
 * change, unlike a rendering slip. See the tests in `config-show.test.ts`.
 */
export type ConfigReport = {
  version: string;
  config_path: string;
  config_exists: boolean;
  dir_config: {
    path: string;
    project: string;
    server: string | null;
  } | null;
  git_remote: string | null;
  context: {
    server: string | null;
    server_source: ServerSource | null;
    token_source: TokenSource | null;
    /** Profile name only; never the token stored under it. */
    token_profile: string | null;
    project: string | null;
    project_source: ProjectSource | null;
  };
  servers: Array<{
    origin: string;
    active: boolean;
    /** Existence only — "is a default identity stored here", not which. */
    default_token: boolean;
    profiles: string[];
  }>;
  bindings: Array<{
    remote: string;
    server: string;
    project: string;
    /** Whether this binding is the one matching the current repository. */
    active: boolean;
  }>;
};

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The single point where credential-bearing values are read. */
export function buildConfigReport(input: {
  version: string;
  config: CliConfig;
  ctx: ResolvedContext;
  env: Env;
}): ConfigReport {
  const { version, config, ctx, env } = input;
  const path = configPath(env);
  return {
    version,
    config_path: path,
    config_exists: fileExists(path),
    dir_config: ctx.dirConfig
      ? {
          path: ctx.dirConfig.path,
          project: ctx.dirConfig.project,
          server: ctx.dirConfig.server ?? null,
        }
      : null,
    git_remote: ctx.remoteUrl,
    context: {
      server: ctx.server ?? null,
      server_source: ctx.serverSource,
      token_source: ctx.tokenSource,
      token_profile: ctx.tokenProfile ?? null,
      project: ctx.project ?? null,
      project_source: ctx.projectSource,
    },
    servers: Object.entries(config.servers)
      // Sorted so the report is byte-identical across runs, which is what
      // lets the tests assert whole outputs instead of fragments.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([origin, entry]) => ({
        origin,
        active: origin === ctx.server,
        default_token: Boolean(entry.token),
        profiles: Object.keys(entry.tokens).sort(),
      })),
    bindings: config.bindings.map((binding) => ({
      remote: binding.remote,
      server: binding.server,
      project: binding.project,
      active: binding.remote === ctx.remoteUrl,
    })),
  };
}

/** `$HOME/x` reads as `~/x`; the JSON keeps the absolute path. */
function tildePath(path: string, env: Env): string {
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  if (!home || home === sep) return path;
  const base = home.endsWith(sep) ? home : home + sep;
  return path.startsWith(base) ? `~${sep}${path.slice(base.length)}` : path;
}

function serverSourceLabel(report: ConfigReport, cwd: string): string | null {
  switch (report.context.server_source) {
    case "flag":
      return "--server";
    case "env":
      return "TODOU_SERVER";
    case "dir-config":
      return report.dir_config
        ? `directory config ${displayPath(report.dir_config.path, cwd)}`
        : "directory config";
    case "binding":
      return report.git_remote
        ? `git binding ${report.git_remote}`
        : "git binding";
    case "default_server":
      return "default_server";
    default:
      return null;
  }
}

function projectSourceLabel(report: ConfigReport, cwd: string): string | null {
  switch (report.context.project_source) {
    case "flag":
      return "--project";
    case "env":
      return "TODOU_PROJECT";
    case "dir-config":
      return report.dir_config
        ? `directory config ${displayPath(report.dir_config.path, cwd)}`
        : "directory config";
    case "binding":
      return report.git_remote
        ? `git binding ${report.git_remote}`
        : "git binding";
    default:
      return null;
  }
}

function withSource(value: string, source: string | null): string {
  return source === null ? value : `${value} (${source})`;
}

/** How the identity was chosen — never anything about what it is. */
function tokenLine(report: ConfigReport): string {
  const { token_source, token_profile, server } = report.context;
  const profile = `profile "${token_profile}"`;
  switch (token_source) {
    case "flag-profile":
      return `${profile} (--profile)`;
    case "env-profile":
      return `${profile} (TODOU_PROFILE)`;
    case "auto-harness":
      return `${profile} (auto-detected harness)`;
    case "auto-harness-shared":
      return `${profile} (auto-detected harness, no profile of its own)`;
    case "env-token":
      return "TODOU_TOKEN (env)";
    case "default":
      return "default token";
    default:
      return server === null ? "none" : `none (run \`todou login ${server}\`)`;
  }
}

function serversBlock(report: ConfigReport): string[] {
  if (report.servers.length === 0) return ["servers: none"];
  return [
    "servers:",
    ...report.servers.map(
      (entry) =>
        `${entry.active ? "*" : " "} ${entry.origin} — default token: ` +
        `${entry.default_token ? "set" : "none"} · profiles: ` +
        `${entry.profiles.length === 0 ? "none" : entry.profiles.join(", ")}`,
    ),
  ];
}

function bindingsBlock(report: ConfigReport): string[] {
  if (report.bindings.length === 0) return ["bindings: none"];
  return [
    "bindings:",
    ...report.bindings.map(
      (binding) =>
        `${binding.active ? "*" : " "} ${binding.remote} → ${binding.server}` +
        ` · project ${binding.project}`,
    ),
  ];
}

export function renderConfigReport(
  report: ConfigReport,
  cwd: string,
  env: Env,
): string {
  const lines = [
    `todou ${report.version}`,
    `user config: ${tildePath(report.config_path, env)}` +
      (report.config_exists ? "" : " (not found)"),
    `directory config: ${
      report.dir_config ? displayPath(report.dir_config.path, cwd) : "none"
    }`,
    "",
    "context:",
    `  server: ${
      report.context.server === null
        ? "none (pass --server, set TODOU_SERVER, or run `todou login <origin>`)"
        : withSource(report.context.server, serverSourceLabel(report, cwd))
    }`,
    `  token: ${tokenLine(report)}`,
    `  project: ${
      report.context.project === null
        ? "none"
        : withSource(report.context.project, projectSourceLabel(report, cwd))
    }`,
    "",
    ...serversBlock(report),
  ];
  // "Why did my binding not take" is one of the questions this command
  // exists to answer, and an unmatched remote is the usual reason. A
  // matched one is already the starred row, so it is not repeated.
  if (report.git_remote !== null && !report.bindings.some((b) => b.active)) {
    lines.push("", `git remote: ${report.git_remote} (no binding)`);
  }
  lines.push("", ...bindingsBlock(report));
  return lines.join("\n");
}

/**
 * Purely local, so it answers in the two states `whoami` cannot reach: no
 * server resolved, and no token stored. Hence a plain Command — ApiCommand
 * would fail both guards before printing a word (T-185).
 */
export class ConfigShowCommand extends Command<CliContext> {
  static paths = [["config", "show"]];
  static usage = Command.Usage({
    description:
      "Show the resolved configuration and where each part came from",
    details:
      "Reads the user config, the directory config, the environment and the " +
      "git remote, and resolves them exactly as a real command would. It " +
      "talks to no server, so it still answers when nothing is configured " +
      "and when the server is unreachable — which is when the question is " +
      "usually asked. `todou whoami` answers the other half: who the server " +
      "thinks you are.\n\n" +
      "It never prints token values, in any form — not truncated, not " +
      "masked, not fingerprinted. `default token: set` and the profile " +
      "names are the whole of what it says about stored credentials. To " +
      "make an authenticated call, use `todou api`; no workflow needs a " +
      "token in your hands.",
    examples: [
      ["What is configured here", "$0 config show"],
      ["The same, for a script", "$0 config show --json"],
    ],
  });

  serverFlag = Option.String("--server", {
    description: "Resolve as if this server origin had been passed",
  });
  profile = Option.String("--profile", {
    description:
      'Resolve as if this profile had been passed ("default" = the default token)',
  });
  json = Option.Boolean("--json", false, {
    description: "Print the report as JSON",
  });

  async execute(): Promise<number | undefined> {
    try {
      const env = this.context.env;
      const config = loadCliConfig(env);
      // No -p flag on purpose: echoing back a project the caller just typed
      // carries no information, and every other input is read from disk.
      const ctx = resolveContext({
        flags: { server: this.serverFlag, profile: this.profile },
        env,
        config,
        remoteUrl: gitRemoteUrl(this.context.cwd),
        dirConfig: discoverDirConfig(this.context.cwd, env),
      });
      const report = buildConfigReport({
        // One version string across `--version` and this report; a bug
        // report quoting two different builds helps nobody.
        version: this.cli.binaryVersion ?? resolveVersion(),
        config,
        ctx,
        env,
      });
      const text = this.json
        ? JSON.stringify(report, null, 2)
        : renderConfigReport(report, this.context.cwd, env);
      this.context.stdout.write(`${text}\n`);
      return 0;
    } catch (error) {
      return reportError(error, this.context.stderr);
    }
  }
}
