import { spawnSync } from "node:child_process";
import type { Binding, CliConfig, Env, ServerEntry } from "./config.ts";
import { normalizeServer } from "./config.ts";
import { CliError } from "./errors.ts";

function git(cwd: string, args: string[]): string | null {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  const out = res.stdout.trim();
  return out === "" ? null : out;
}

/**
 * The binding key for the repository containing `cwd`: origin's URL, or the
 * sole remote's when there is no origin. Anything ambiguous (several remotes,
 * no remotes, not a repository, git missing) resolves to null so commands
 * fall back to explicit flags instead of guessing.
 */
export function gitRemoteUrl(cwd: string): string | null {
  const origin = git(cwd, ["remote", "get-url", "origin"]);
  if (origin) return origin;
  const names = git(cwd, ["remote"])?.split("\n").filter(Boolean) ?? [];
  if (names.length !== 1) return null;
  return git(cwd, ["remote", "get-url", names[0] as string]);
}

export type TokenSource =
  | "flag-profile"
  | "env-token"
  | "env-profile"
  | "auto-claude-code"
  | "default";

export type ResolvedContext = {
  server?: string;
  token?: string;
  tokenSource: TokenSource | null;
  /** Profile name when tokenSource is a profile (incl. auto-claude-code). */
  tokenProfile?: string;
  project?: string;
  binding: Binding | null;
  remoteUrl: string | null;
};

type PickedToken = Pick<
  ResolvedContext,
  "token" | "tokenSource" | "tokenProfile"
>;

/** Throws CliError for an explicitly requested profile that does not exist. */
function pickToken(
  flagProfile: string | undefined,
  env: Env,
  server: string | undefined,
  entry: ServerEntry | undefined,
): PickedToken {
  const lookup = (
    name: string,
    tokenSource: "flag-profile" | "env-profile",
  ): PickedToken => {
    if (name === "default") {
      // Reserved name: bypasses the auto rule back to the default token.
      return { token: entry?.token, tokenSource: "default" };
    }
    const token = entry?.tokens[name];
    if (!token) {
      const available = Object.keys(entry?.tokens ?? {});
      throw new CliError(
        `unknown profile "${name}" for ${server}`,
        available.length > 0
          ? `available: ${available.join(", ")} (or "default")`
          : `no profiles stored; run \`todou login ${server} --profile ${name}\``,
      );
    }
    return { token, tokenSource, tokenProfile: name };
  };

  // A profile lookup is meaningless without a server; let the missing-server
  // error surface first instead of a confusing profile complaint.
  if (server === undefined) return { token: undefined, tokenSource: null };
  if (flagProfile) return lookup(flagProfile, "flag-profile");
  if (env.TODOU_TOKEN) {
    return { token: env.TODOU_TOKEN, tokenSource: "env-token" };
  }
  if (env.TODOU_PROFILE) return lookup(env.TODOU_PROFILE, "env-profile");
  const claude = entry?.tokens["claude-code"];
  if (env.CLAUDECODE === "1" && claude) {
    return {
      token: claude,
      tokenSource: "auto-claude-code",
      tokenProfile: "claude-code",
    };
  }
  if (entry?.token) return { token: entry.token, tokenSource: "default" };
  return { token: undefined, tokenSource: null };
}

export function resolveContext(input: {
  flags: { server?: string; project?: string; profile?: string };
  env: Env;
  config: CliConfig;
  remoteUrl: string | null;
}): ResolvedContext {
  const { flags, env, config, remoteUrl } = input;
  const binding = remoteUrl
    ? (config.bindings.find((b) => b.remote === remoteUrl) ?? null)
    : null;

  const server = normalizeIfSet(
    flags.server ||
      env.TODOU_SERVER ||
      binding?.server ||
      config.default_server,
  );
  const picked = pickToken(
    flags.profile,
    env,
    server,
    server ? config.servers[server] : undefined,
  );
  // The bound project belongs to the bound server; when --server/TODOU_SERVER
  // points elsewhere, silently reusing the slug could hit an unrelated
  // project that happens to share it.
  const project =
    flags.project ||
    env.TODOU_PROJECT ||
    (binding && normalizeServer(binding.server) === server
      ? binding.project
      : undefined);

  return { server, ...picked, project, binding, remoteUrl };
}

function normalizeIfSet(origin: string | undefined): string | undefined {
  return origin === undefined ? undefined : normalizeServer(origin);
}
