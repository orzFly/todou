import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { patch } from "@decimalturn/toml-patch";
import {
  ConfigError,
  deepMergeDocs,
  loadTomlDocs,
  type TomlDoc,
} from "@todou/shared/config";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

// Loose throughout: `saveCliConfig` writes back what was parsed, so a key
// the schema does not know has to survive the parse to survive the write.
export const Binding = z.looseObject({
  /** git remote URL of the repository this binding applies to. */
  remote: z.string(),
  server: z.string(),
  project: z.string(),
});
export type Binding = z.infer<typeof Binding>;

export const ServerEntry = z.looseObject({
  /**
   * A short input spelling for this origin (T-366). The charset excludes
   * ":" and "/", so a name can never collide with any URL form, and the
   * origin stays the only identity: keys, bindings, default_server.
   */
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .optional(),
  /** Default identity; optional so a server may hold only named profiles. */
  token: z.string().optional(),
  /** Named token profiles, e.g. tokens."claude-code". */
  tokens: z.record(z.string(), z.string()).default({}),
  /** Other base URLs this same deployment answers at (git's insteadOf). */
  instead_of: z.array(z.string()).default([]),
  /**
   * Text a `--follow` push carries before and after each batch (T-609).
   * Unset by default and never filled in by the CLI: what an agent is told
   * about its tracker activity is the user's call, not the tracker's.
   */
  follow_header: z.string().optional(),
  follow_footer: z.string().optional(),
});
export type ServerEntry = z.infer<typeof ServerEntry>;

export const CliConfig = z.looseObject({
  default_server: z.string().optional(),
  servers: z.record(z.string(), ServerEntry).default({}),
  bindings: z.array(Binding).default([]),
  /**
   * Machine-wide preferences an agent's advice reads. Optional and
   * undefaulted, unlike the tables above: a defaulted table would make every
   * `todou login` grow an `[agent]` section nobody asked for. Absent means
   * "advise everything".
   */
  agent: z.looseObject({ follow_uds: z.boolean().optional() }).optional(),
});
export type CliConfig = z.infer<typeof CliConfig>;

export type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "todou", "config.toml");
}

/** `$HOME/x` reads as `~/x`; a JSON report keeps the absolute path. */
export function tildePath(path: string, env: Env): string {
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  if (!home || home === sep) return path;
  const base = home.endsWith(sep) ? home : home + sep;
  return path.startsWith(base) ? `~${sep}${path.slice(base.length)}` : path;
}

/**
 * Every config file to read, in merge order: `config.*.toml` fragments
 * by lexicographic filename, then `config.toml` appended last so it is
 * both the final say and the write target. The glob cannot pick up
 * `config.toml` itself (its only dot is the one the prefix ends with),
 * so "last" is spliced in, never sorted into place.
 *
 * A name like `config.x.toml` owned by a directory is not a TOML
 * document; `statSync` (which follows symlinks) lets a symlink to a
 * regular file in and keeps directories out.
 */
export function discoverConfigFiles(env: Env = process.env): string[] {
  const own = configPath(env);
  let entries: string[];
  try {
    entries = readdirSync(dirname(own));
  } catch {
    return [own];
  }
  const fragments = entries
    .filter((name) => {
      if (!name.startsWith("config.") || !name.endsWith(".toml")) {
        return false;
      }
      const middle = name.slice("config.".length, -".toml".length);
      if (middle.length === 0) return false;
      try {
        return statSync(join(dirname(own), name)).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => join(dirname(own), name));
  return [...fragments, own];
}

export type CliConfigSet = {
  /** The merged, validated view every reader uses. */
  config: CliConfig;
  /** `config.toml` alone, validated; the only document `saveCliConfig` writes. */
  own: CliConfig;
  /** Every document read, in merge order (`config.toml` last when present). */
  files: Array<TomlDoc>;
};

/**
 * Validation happens exactly once, on the merged raw documents: zod
 * defaults applied per file would let a fragment's empty `instead_of`
 * overwrite an alias a later file actually configured.
 */
export function parseCliConfigSet(
  files: Array<TomlDoc>,
  env: Env,
): CliConfigSet {
  const ownPath = configPath(env);
  const merged = CliConfig.safeParse(
    deepMergeDocs(
      files.map((f) => f.doc),
      { concatArrays: [["bindings"]] },
    ),
  );
  if (!merged.success) {
    throw new ConfigError(`invalid config: ${merged.error.message}`);
  }
  const ownDoc = files.find((f) => f.path === ownPath)?.doc ?? {};
  const own = CliConfig.safeParse(ownDoc);
  if (!own.success) {
    throw new ConfigError(`invalid config in ${ownPath}: ${own.error.message}`);
  }
  return { config: merged.data, own: own.data, files };
}

export function loadCliConfigSet(env: Env = process.env): CliConfigSet {
  return parseCliConfigSet(
    loadTomlDocs({ paths: discoverConfigFiles(env) }),
    env,
  );
}

export function loadCliConfig(env: Env = process.env): CliConfig {
  return loadCliConfigSet(env).config;
}

/** Tokens live here, so the directory is 0700 and the file 0600. */
export function saveCliConfig(config: CliConfig, env: Env = process.env): void {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const doc = withoutUndefined(config) as {
    servers?: Record<
      string,
      { tokens?: Record<string, string>; instead_of?: string[] }
    >;
    bindings?: unknown[];
  } & Record<string, unknown>;
  // Empty profile tables would render as noisy empty [servers.X.tokens]
  // sections; the schema defaults them back on load. An empty alias list
  // goes the same way, for the same reason — a hand-written config must
  // not grow `instead_of = []` under it — and so do the top-level defaults.
  for (const entry of Object.values(doc.servers ?? {})) {
    if (entry.tokens && Object.keys(entry.tokens).length === 0) {
      delete entry.tokens;
    }
    if (entry.instead_of && entry.instead_of.length === 0) {
      delete entry.instead_of;
    }
  }
  if (doc.servers && Object.keys(doc.servers).length === 0) {
    delete doc.servers;
  }
  if (doc.bindings?.length === 0) delete doc.bindings;
  let existing: string | undefined;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = undefined;
  }
  writeFileSync(path, renderToml(existing, doc), { mode: 0o600 });
  // writeFileSync applies mode only on create; tighten pre-existing files too.
  chmodSync(path, 0o600);
}

/**
 * The text that reads back as `doc`, keeping the comments and layout of
 * `existing` where it can. toml-patch edits values in place, but a table or
 * `[[array]]` the file does not have yet either throws ("Node not found") or
 * lands as an inline table among the root keys, so those are appended as
 * sections instead. A candidate is written only if the loader's own parser
 * reads it back as `doc`: a file the appending cannot extend (`servers =
 * { … }` written inline, say) costs its comments, never a value.
 */
export function renderToml(
  existing: string | undefined,
  doc: Record<string, unknown>,
): string {
  const fresh = `${stringify(doc)}\n`;
  if (existing === undefined || existing.trim() === "") return fresh;
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const candidates = [
    () => {
      const { kept, added } = splitAdditions(parse(existing), doc);
      const patched = patch(existing, kept);
      if (Object.keys(added).length === 0) return patched;
      const sections = stringify(added).trimEnd().replace(/\r?\n/g, newline);
      return `${patched.trimEnd()}${newline}${newline}${sections}${newline}`;
    },
    () => patch(existing, doc),
  ];
  for (const candidate of candidates) {
    try {
      const text = candidate();
      if (isDeepStrictEqual(parse(text), doc)) return text;
    } catch {}
  }
  return fresh;
}

/** `after`, split into what `before` has a place for and the sections it lacks. */
function splitAdditions(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { kept: Record<string, unknown>; added: Record<string, unknown> } {
  const kept: Record<string, unknown> = {};
  const added: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    const prior = before[key];
    if (prior === undefined && isSection(value)) {
      added[key] = value;
    } else if (isTable(value) && isTable(prior)) {
      const inner = splitAdditions(prior, value);
      kept[key] = inner.kept;
      if (Object.keys(inner.added).length > 0) added[key] = inner.added;
    } else {
      kept[key] = value;
    }
  }
  return { kept, added };
}

function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isSection(value: unknown): boolean {
  return (
    isTable(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isTable))
  );
}

/** smol-toml rejects `undefined`, which is how zod leaves an unset optional. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isTable(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, withoutUndefined(v)]),
  );
}

/** Origins are dictionary keys; a trailing slash would silently fork entries. */
export function normalizeServer(origin: string): string {
  return origin.replace(/\/+$/, "");
}
