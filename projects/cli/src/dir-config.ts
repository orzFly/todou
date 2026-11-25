import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Env } from "./config.ts";
import { normalizeServer } from "./config.ts";
import { CliError } from "./errors.ts";

/** A directory config in effect: the file found and what it pins. */
export type DirConfig = {
  path: string;
  project: string;
  server?: string;
};

/** Same-directory precedence: the .config/ variant wins (T-133). */
export const DIR_CONFIG_NAMES = [
  join(".config", "todou.toml"),
  ".todou.toml",
] as const;

/** A config path as the user should read it: relative to cwd, "./"-anchored. */
export function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? rel : `./${rel}`;
}

const DirConfigFile = z.object({
  project: z.string(),
  server: z.string().optional(),
});

/**
 * These files travel with a directory — often into a committed, public
 * tree — so credential-shaped keys are refused loudly: silently ignoring
 * them would let someone believe their token is configured.
 */
const CREDENTIAL_KEYS = ["token", "tokens", "servers"];

async function parseDirConfig(path: string): Promise<Omit<DirConfig, "path">> {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new CliError(
      `cannot parse directory config ${path}: ${String(cause)}`,
    );
  }
  for (const key of CREDENTIAL_KEYS) {
    if (key in raw) {
      throw new CliError(
        `directory config ${path} contains "${key}"`,
        "credentials belong in the user config (`todou login`), never in a directory config",
      );
    }
  }
  if (raw.project === undefined) {
    throw new CliError(
      `directory config ${path} has no "project" key`,
      'a directory config must name a project, e.g. project = "todou"',
    );
  }
  const parsed = DirConfigFile.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      `invalid directory config ${path}: ${parsed.error.message}`,
    );
  }
  return {
    project: parsed.data.project,
    server:
      parsed.data.server === undefined
        ? undefined
        : normalizeServer(parsed.data.server),
  };
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function defaultDevOf(path: string): Promise<number | undefined> {
  return (await statOrNull(path))?.dev;
}

async function resolveHome(env: Env): Promise<string | null> {
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  return home ? realpathOr(home) : null;
}

async function resolveXdgConfigHome(
  env: Env,
  home: string | null,
): Promise<string | null> {
  const fromEnv = env.XDG_CONFIG_HOME;
  if (fromEnv && isAbsolute(fromEnv)) return realpathOr(fromEnv);
  return home === null ? null : realpathOr(join(home, ".config"));
}

function isAncestorOf(dir: string, descendant: string): boolean {
  return descendant.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Whether the walk may continue above `dir` once nothing was found in it.
 * A repository root ends the walk — a repo is self-contained, and with
 * directory configs outranking bindings, walking on would let a file
 * outside the repo hijack every linked repo beneath it. A submodule root
 * is the exception: submodules are components of their superproject, so
 * the walk continues into it.
 */
async function vcsRootStopsWalk(dir: string): Promise<boolean> {
  const gitPath = join(dir, ".git");
  const git = await statOrNull(gitPath);
  if (git?.isDirectory()) return true;
  if (git?.isFile()) {
    let text: string;
    try {
      text = await readFile(gitPath, "utf8");
    } catch {
      return true;
    }
    // A submodule's gitdir points into the superproject's .git/modules/;
    // a linked worktree's points into .git/worktrees/ and is a standalone
    // checkout that may physically sit anywhere — unreadable or unknown
    // contents stop the walk too, erring toward the smaller reach.
    const gitdir = text.match(/^gitdir:\s*(.+)$/m)?.[1];
    return !(gitdir && /\.git[\\/]modules[\\/]/.test(gitdir));
  }
  return (
    (await statOrNull(join(dir, ".hg"))) !== null ||
    (await statOrNull(join(dir, ".svn"))) !== null
  );
}

/**
 * Find the directory config governing `cwd`: walk upward, nearest file
 * wins, `.config/todou.toml` before `.todou.toml` within one directory.
 *
 * The walk never enters global-config territory — $HOME, its ancestors,
 * and $XDG_CONFIG_HOME are walls, so `~/.config/todou.toml` can never be
 * mistaken for a directory config. It also stops at filesystem boundaries
 * (the GIT_DISCOVERY_ACROSS_FILESYSTEM=false semantics) and at VCS roots,
 * except submodule roots which it walks through.
 *
 * A file that exists but cannot be used (bad TOML, no project, credential
 * keys) throws instead of being skipped: skipping would let the command
 * silently resolve to a different project further up.
 */
export async function discoverDirConfig(
  cwd: string,
  env: Env = process.env,
  seams?: {
    devOf?: (path: string) => number | undefined | Promise<number | undefined>;
  },
): Promise<DirConfig | null> {
  let dir: string;
  try {
    dir = await realpath(cwd);
  } catch {
    return null;
  }
  const home = await resolveHome(env);
  const xdgConfigHome = await resolveXdgConfigHome(env, home);
  const devOf = seams?.devOf ?? defaultDevOf;
  const startDev = await devOf(dir);
  if (startDev === undefined) return null;

  while (true) {
    if (home !== null && (dir === home || isAncestorOf(dir, home))) {
      return null;
    }
    if (dir === xdgConfigHome) return null;
    if ((await devOf(dir)) !== startDev) return null;
    for (const name of DIR_CONFIG_NAMES) {
      const candidate = join(dir, name);
      if ((await statOrNull(candidate))?.isFile()) {
        return { path: candidate, ...(await parseDirConfig(candidate)) };
      }
    }
    if (await vcsRootStopsWalk(dir)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
