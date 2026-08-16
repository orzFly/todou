import { spawnSync } from "node:child_process";
import type { Binding, CliConfig, Env, ServerEntry } from "./config.ts";
import { normalizeServer } from "./config.ts";
import type { DirConfig } from "./dir-config.ts";
import { CliError } from "./errors.ts";
import { detectHarnessId } from "./harness/index.ts";

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

/** Root of the working tree containing `cwd`; null outside any repository. */
export function gitToplevel(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export type TokenSource =
  | "flag-profile"
  | "env-token"
  | "env-profile"
  | "auto-harness"
  | "auto-harness-shared"
  | "default";

/**
 * One identity for every harness, so a fleet of agents needs a single
 * machine account rather than one per harness. A profile named after a
 * specific harness still wins, which is how one harness is given an
 * identity of its own without disturbing the rest.
 */
const SHARED_HARNESS_PROFILE = "harness";

export type ProjectSource = "flag" | "env" | "dir-config" | "binding";

export type ResolvedContext = {
  server?: string;
  token?: string;
  tokenSource: TokenSource | null;
  /** Profile name when tokenSource is a profile (incl. both auto rules). */
  tokenProfile?: string;
  project?: string;
  /** Where `project` came from; null when it stayed unresolved. */
  projectSource: ProjectSource | null;
  binding: Binding | null;
  dirConfig: DirConfig | null;
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
  // A profile named after the detected harness opts that harness into its
  // own identity, and "harness" covers every harness that has none. Being
  // inside a harness is the entire trigger: outside one, neither applies
  // and the auto rule stays inert even when "harness" is stored.
  const harnessId = detectHarnessId(env);
  if (harnessId) {
    const own = entry?.tokens[harnessId];
    if (own) {
      return {
        token: own,
        tokenSource: "auto-harness",
        tokenProfile: harnessId,
      };
    }
    const shared = entry?.tokens[SHARED_HARNESS_PROFILE];
    if (shared) {
      return {
        token: shared,
        tokenSource: "auto-harness-shared",
        tokenProfile: SHARED_HARNESS_PROFILE,
      };
    }
  }
  if (entry?.token) return { token: entry.token, tokenSource: "default" };
  return { token: undefined, tokenSource: null };
}

export function resolveContext(input: {
  flags: { server?: string; project?: string; profile?: string };
  env: Env;
  config: CliConfig;
  remoteUrl: string | null;
  dirConfig: DirConfig | null;
}): ResolvedContext {
  const { flags, env, config, remoteUrl, dirConfig } = input;
  const binding = remoteUrl
    ? (config.bindings.find((b) => b.remote === remoteUrl) ?? null)
    : null;

  // A directory config replaces the binding as the local source outright:
  // one local source at a time, never a blend of file and binding fields —
  // so a file without a server key falls through to default_server, not to
  // the binding's server.
  const server = normalizeIfSet(
    flags.server ||
      env.TODOU_SERVER ||
      (dirConfig ? dirConfig.server : binding?.server) ||
      config.default_server,
  );
  const picked = pickToken(
    flags.profile,
    env,
    server,
    server ? config.servers[server] : undefined,
  );
  // A local project pinned to a server belongs to that server; when
  // --server/TODOU_SERVER points elsewhere, silently reusing the slug
  // could hit an unrelated project that happens to share it. A file
  // without a server key floats onto whatever server is active.
  const localProject = dirConfig
    ? dirConfig.server === undefined ||
      normalizeServer(dirConfig.server) === server
      ? dirConfig.project
      : undefined
    : binding && normalizeServer(binding.server) === server
      ? binding.project
      : undefined;
  const project = flags.project || env.TODOU_PROJECT || localProject;
  const projectSource: ProjectSource | null = flags.project
    ? "flag"
    : env.TODOU_PROJECT
      ? "env"
      : localProject === undefined
        ? null
        : dirConfig
          ? "dir-config"
          : "binding";

  return {
    server,
    ...picked,
    project,
    projectSource,
    binding,
    dirConfig,
    remoteUrl,
  };
}

function normalizeIfSet(origin: string | undefined): string | undefined {
  return origin === undefined ? undefined : normalizeServer(origin);
}
