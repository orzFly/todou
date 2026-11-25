// Node-only: exported as `@todou/shared/config`, deliberately kept out of
// the browser-facing "." export because it reads the filesystem. Only the
// asynchronous read lives here: the CLI imports this module, and the CLI's
// single-file build runs on a runtime with no synchronous file API (T-792).
// The server's synchronous loader is `@todou/shared/config-file`.
import { readFile } from "node:fs/promises";
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
export async function loadTomlDocs(options: {
  paths: string[];
}): Promise<Array<TomlDoc>> {
  const docs: Array<TomlDoc> = [];
  for (const path of options.paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
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
