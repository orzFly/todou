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
