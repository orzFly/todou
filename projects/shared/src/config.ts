// Node-only: exported as `@todou/shared/config`, deliberately kept out of
// the browser-facing "." export because it reads the filesystem.
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export class ConfigError extends Error {}

/** TOML supplies real booleans; ENV supplies "true"/"false"/"1"/"0". */
export const flexibleBool = z.preprocess(
  (v) => (typeof v === "string" ? v === "true" || v === "1" : v),
  z.boolean(),
);

export function setPath(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[path.at(-1) as string] = value;
}

export type TomlDoc = { path: string; doc: Record<string, unknown> };

/**
 * Read several TOML files in the given order. ENOENT is the one normal
 * miss — a file the caller globbed for need not exist — while anything
 * else (permissions, a directory, bad syntax) names its file and throws:
 * silently skipping one document of a merged set would quietly change
 * which server and which identity a command ends up using.
 */
export function loadTomlDocs(options: { paths: string[] }): Array<TomlDoc> {
  const docs: Array<TomlDoc> = [];
  for (const path of options.paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new ConfigError(`cannot read config ${path}: ${String(cause)}`);
    }
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch (cause) {
      throw new ConfigError(`cannot read config ${path}: ${String(cause)}`);
    }
    docs.push({ path, doc });
  }
  return docs;
}

/**
 * A plain record, not a class instance: smol-toml's datetimes come back
 * as a Date subclass, and merging one as an object would shred it into
 * its own integer keys.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Overlay the documents in order, later wins. Tables merge recursively;
 * everything else replaces whole — except an array at a path listed in
 * `concatArrays`, where the earlier document's items come first.
 */
export function deepMergeDocs(
  docs: Array<Record<string, unknown>>,
  options: { concatArrays?: string[][] } = {},
): Record<string, unknown> {
  const concat = new Set(
    (options.concatArrays ?? []).map((path) => path.join("\u0000")),
  );
  const mergeAt = (
    path: string[],
    earlier: unknown,
    later: unknown,
  ): unknown => {
    if (isPlainObject(earlier) && isPlainObject(later)) {
      const out: Record<string, unknown> = { ...earlier };
      for (const [key, value] of Object.entries(later)) {
        out[key] = mergeAt([...path, key], out[key], value);
      }
      return out;
    }
    if (
      Array.isArray(earlier) &&
      Array.isArray(later) &&
      concat.has(path.join("\u0000"))
    ) {
      return [...earlier, ...later];
    }
    return later;
  };
  return docs.reduce(
    (merged, doc) => mergeAt([], merged, doc) as Record<string, unknown>,
    {},
  );
}

export function loadTomlConfig<S extends z.ZodType>(options: {
  schema: S;
  /** File to read when `tomlSource` is absent. */
  path?: string;
  /** Parse this string instead of reading `path`. */
  tomlSource?: string;
  /** When true, a missing/unreadable `path` yields an empty document. */
  optional?: boolean;
  /** ENV names → config paths. ENV always wins over TOML. */
  envMap?: Array<[string, string[]]>;
  env?: Record<string, string | undefined>;
}): z.infer<S> {
  const env = options.env ?? process.env;

  let raw: Record<string, unknown> = {};
  if (options.tomlSource !== undefined) {
    raw = parseToml(options.tomlSource) as Record<string, unknown>;
  } else if (options.path !== undefined) {
    try {
      raw = parseToml(readFileSync(options.path, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (cause) {
      if (!options.optional) {
        throw new ConfigError(
          `cannot read config ${options.path}: ${String(cause)}`,
        );
      }
    }
  }

  for (const [name, path] of options.envMap ?? []) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      setPath(raw, path, value);
    }
  }

  const parsed = options.schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid config: ${parsed.error.message}`);
  }
  return parsed.data as z.infer<S>;
}
