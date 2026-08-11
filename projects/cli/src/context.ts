import { spawnSync } from "node:child_process";
import type { Binding, CliConfig, Env } from "./config.ts";
import { normalizeServer } from "./config.ts";

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

export type ResolvedContext = {
  server?: string;
  token?: string;
  project?: string;
  binding: Binding | null;
};

export function resolveContext(input: {
  flags: { server?: string; project?: string };
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
  const token =
    env.TODOU_TOKEN ||
    (server ? config.servers[server]?.token : undefined) ||
    undefined;
  // The bound project belongs to the bound server; when --server/TODOU_SERVER
  // points elsewhere, silently reusing the slug could hit an unrelated
  // project that happens to share it.
  const project =
    flags.project ||
    env.TODOU_PROJECT ||
    (binding && normalizeServer(binding.server) === server
      ? binding.project
      : undefined);

  return { server, token, project, binding };
}

function normalizeIfSet(origin: string | undefined): string | undefined {
  return origin === undefined ? undefined : normalizeServer(origin);
}
