import { statSync } from "node:fs";
import { resolveVersion } from "@todou/shared/version";
import { Command, Option } from "clipanion";
import type { CliContext } from "../api-command.ts";
import type { CliConfig, Env } from "../config.ts";
import {
  configPath,
  loadCliConfigSet,
  normalizeServer,
  tildePath,
} from "../config.ts";
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
  /** Every file read, in merge order; `config_path` is the write target. */
  config_files: string[];
  dir_config: {
    path: string;
    project: string;
    server: string | null;
  } | null;
  git_remote: string | null;
  context: {
    server: string | null;
    server_source: ServerSource | null;
    /** The alias `server` was rewritten from; null when none matched. */
    server_instead_of: string | null;
    /** The name `server` was resolved from; null when the input was a URL. */
    server_name: string | null;
    /** The winning input was neither a URL nor a known name (T-366). */
    server_unknown_name: boolean;
    token_source: TokenSource | null;
    /** Profile name only; never the token stored under it. */
    token_profile: string | null;
    project: string | null;
    project_source: ProjectSource | null;
  };
  servers: Array<{
    origin: string;
    active: boolean;
    /** The entry's `name`, for display; null when it has none. */
    name: string | null;
    /** Existence only — "is a default identity stored here", not which. */
    default_token: boolean;
    profiles: string[];
    /** This entry's `instead_of`, normalized; empty when it has none. */
    instead_of: string[];
  }>;
  bindings: Array<{
    remote: string;
    server: string;
    project: string;
    /** Which file this binding was read from (a merge-order survivor). */
    source: string;
    /** Whether this binding is the one matching the current repository. */
    active: boolean;
  }>;
  agent: {
    /** Whether `can-i-follow` may offer the push transport here. */
    follow_uds: boolean;
  };
};

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The single point where credential-bearing values are read. `files` is
 * the merge-order document set behind `config` — the whole basis for
 * binding source attribution, so the report never rebuilds it.
 */
export function buildConfigReport(input: {
  version: string;
  config: CliConfig;
  files: Array<{ path: string; doc: Record<string, unknown> }>;
  ctx: ResolvedContext;
  env: Env;
}): ConfigReport {
  const { version, config, files, ctx, env } = input;
  const path = configPath(env);
  // Which file a merged binding came from: the last document (merge
  // order, later wins) carrying a binding with this remote.
  const sourceOf = (remote: string): string => {
    for (const file of [...files].reverse()) {
      const bindings = file.doc.bindings;
      if (!Array.isArray(bindings)) continue;
      if (
        (bindings as Array<{ remote?: string }>).some(
          (b) => b.remote === remote,
        )
      ) {
        return file.path;
      }
    }
    return path;
  };
  return {
    version,
    config_path: path,
    config_exists: fileExists(path),
    config_files: files.map((f) => f.path),
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
      server_instead_of: ctx.serverInsteadOf ?? null,
      server_name: ctx.serverName ?? null,
      server_unknown_name: ctx.serverUnknownName,
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
        name: entry.name ?? null,
        default_token: Boolean(entry.token),
        profiles: Object.keys(entry.tokens).sort(),
        // Addresses, not credentials: `ConfigReport` stays a type with no
        // field a token value could be assigned to.
        instead_of: entry.instead_of.map(normalizeServer),
      })),
    bindings: config.bindings.map((binding) => ({
      remote: binding.remote,
      server: binding.server,
      project: binding.project,
      source: sourceOf(binding.remote),
      active: binding.remote === ctx.remoteUrl,
    })),
    agent: { follow_uds: config.agent?.follow_uds ?? true },
  };
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

/**
 * A value and where it came from, with the alias or name it was resolved
 * from inside the same parentheses (T-311, T-366): those clauses belong
 * to the source, and a line carrying two bracket groups would read as
 * two facts.
 */
function withSource(
  value: string,
  source: string | null,
  via: string | null = null,
): string {
  if (source === null) return via === null ? value : `${value} (${via})`;
  return `${value} (${source}${via === null ? "" : `, ${via}`})`;
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
        `${entry.active ? "*" : " "} ${entry.origin} — ` +
        (entry.name === null ? "" : `name: ${entry.name} · `) +
        `default token: ${entry.default_token ? "set" : "none"} · profiles: ` +
        `${entry.profiles.length === 0 ? "none" : entry.profiles.join(", ")}` +
        // Printed only when there is something to say, following the
        // `--follow=uds: opted out` precedent: an ordinary config's output
        // is byte-identical to what it was before names and aliases existed.
        (entry.instead_of.length === 0
          ? ""
          : ` · instead_of: ${entry.instead_of.join(", ")}`),
    ),
  ];
}

function bindingsBlock(report: ConfigReport, cwd: string): string[] {
  if (report.bindings.length === 0) return ["bindings: none"];
  return [
    "bindings:",
    ...report.bindings.map((binding) => {
      // The owning file is named only when it is not the write target:
      // with one file, every line saying "config.toml" says nothing.
      const source =
        binding.source === report.config_path
          ? ""
          : ` · from ${displayPath(binding.source, cwd)}`;
      return (
        `${binding.active ? "*" : " "} ${binding.remote} → ${binding.server}` +
        ` · project ${binding.project}${source}`
      );
    }),
  ];
}

export function renderConfigReport(
  report: ConfigReport,
  cwd: string,
  env: Env,
): string {
  const lines = [
    `todou ${report.version}`,
    ...userConfigLines(report, env),
    `directory config: ${
      report.dir_config ? displayPath(report.dir_config.path, cwd) : "none"
    }`,
    "",
    "context:",
    `  server: ${
      report.context.server === null
        ? "none (pass --server, set TODOU_SERVER, or run `todou login <origin>`)"
        : withSource(
            report.context.server,
            serverSourceLabel(report, cwd),
            // Printed on the line that answers "why is my server this one",
            // so a --server that silently became another base — by alias
            // or by name — is visible rather than mysterious.
            report.context.server_instead_of === null
              ? report.context.server_name === null
                ? null
                : `via name ${report.context.server_name}`
              : `via instead_of ${report.context.server_instead_of}`,
          )
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
  lines.push("", ...bindingsBlock(report, cwd));
  // The name a config once defined and nothing resolves anymore — the
  // exact state this report exists to describe, and the command a failed
  // one points at. Stated, not fatal.
  if (report.context.server_unknown_name) {
    lines.push(
      "",
      `unknown server name: ${report.context.server} is not a URL and matches no name above`,
    );
  }
  // Printed only when it is set, so ordinary output is unchanged. It names
  // no way back: `config show` is a command agents run, and the opt-out is
  // the user's standing decision to reverse.
  if (!report.agent.follow_uds) lines.push("", "--follow=uds: opted out");
  return lines.join("\n");
}

/**
 * The one line that stays byte-identical when only `config.toml` exists;
 * with fragments read, it becomes the ordered list a merge question
 * needs, with the write target marked.
 */
function userConfigLines(report: ConfigReport, env: Env): string[] {
  if (report.config_files.length <= 1) {
    return [
      `user config: ${tildePath(report.config_path, env)}` +
        (report.config_exists ? "" : " (not found)"),
    ];
  }
  return [
    "user config:",
    ...report.config_files.map(
      (path) =>
        `  ${tildePath(path, env)}${
          path === report.config_path ? " (write target)" : ""
        }`,
    ),
  ];
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
      const { config, files } = loadCliConfigSet(env);
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
        files,
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
