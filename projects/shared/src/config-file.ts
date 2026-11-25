// The server's configuration loader, kept apart from `@todou/shared/config`
// because it reads synchronously: the CLI imports that module, and the CLI's
// single-file build runs on a runtime with no synchronous file API (T-792).
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import type { z } from "zod";
import { ConfigError, setPath } from "./config.ts";

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
