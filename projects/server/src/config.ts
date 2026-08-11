import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/** TOML supplies real booleans; ENV supplies "true"/"false"/"1"/"0". */
const flexibleBool = z.preprocess(
  (v) => (typeof v === "string" ? v === "true" || v === "1" : v),
  z.boolean(),
);

const ConfigSchema = z.object({
  auth: z
    .object({
      mode: z.enum(["single", "oidc", "forward"]).default("single"),
    })
    .default({ mode: "single" }),
  http: z
    .object({
      port: z.coerce.number().int().min(1).max(65535).default(8637),
      static_dir: z.string().optional(),
    })
    .prefault({}),
  database: z
    .object({
      system: z.string().default("pglite://./data/system"),
      auto_migrate: flexibleBool.optional(),
      projects: z
        .object({
          placement: z.enum(["shared", "dedicated"]).default("shared"),
          url_template: z.string().optional(),
          max_open: z.coerce.number().int().min(1).default(32),
          workers: flexibleBool.default(false),
        })
        .prefault({}),
    })
    .prefault({}),
  storage: z
    .object({
      backend: z.enum(["fs"]).default("fs"),
      path: z.string().default("./data/attachments"),
      max_upload_mb: z.coerce.number().positive().default(20),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema> & {
  projectUrlFor: ((project: ProjectRouteInfo) => string) | null;
};

export type ProjectRouteInfo = {
  id: number;
  slug: string;
  database_url?: string | null;
};

const DB_URL_PATTERN = /^(pglite|postgres(ql)?):\/\/.+/;

export function isValidDbUrl(url: string): boolean {
  return DB_URL_PATTERN.test(url);
}

/**
 * The template is admin-trusted config, compiled once at startup as a JS
 * template literal with `project` in scope, so routing logic (id ranges,
 * custom sharding) is expressible inline: e.g.
 * "postgres://${project.id > 100 ? 'pg-b' : 'pg-a'}/todou_${project.id}".
 */
export function compileUrlTemplate(
  template: string,
): (project: ProjectRouteInfo) => string {
  let fn: (project: ProjectRouteInfo) => unknown;
  try {
    fn = new Function("project", `"use strict"; return \`${template}\`;`) as (
      project: ProjectRouteInfo,
    ) => unknown;
  } catch (cause) {
    throw new ConfigError(
      `invalid database.projects.url_template: ${String(cause)}`,
    );
  }
  const resolve = (project: ProjectRouteInfo): string => {
    let url: unknown;
    try {
      url = fn(project);
    } catch (cause) {
      throw new ConfigError(
        `url_template threw for project ${project.id}: ${String(cause)}`,
      );
    }
    if (typeof url !== "string" || !isValidDbUrl(url)) {
      throw new ConfigError(
        `url_template resolved to an invalid database URL for project ${project.id}: ${String(url)}`,
      );
    }
    return url;
  };
  // Smoke-resolve a dummy project so syntax, runtime, and URL-shape errors
  // all surface at startup instead of on first project access.
  resolve({ id: 1, slug: "smoke-test" });
  return resolve;
}

export class ConfigError extends Error {}

/** ENV names → config paths. ENV always wins over TOML. */
const ENV_MAP: Array<[string, string[]]> = [
  ["TODOU_AUTH_MODE", ["auth", "mode"]],
  ["TODOU_HTTP_PORT", ["http", "port"]],
  ["TODOU_HTTP_STATIC_DIR", ["http", "static_dir"]],
  ["TODOU_DATABASE_SYSTEM", ["database", "system"]],
  ["TODOU_DATABASE_AUTO_MIGRATE", ["database", "auto_migrate"]],
  ["TODOU_DATABASE_PROJECTS_PLACEMENT", ["database", "projects", "placement"]],
  [
    "TODOU_DATABASE_PROJECTS_URL_TEMPLATE",
    ["database", "projects", "url_template"],
  ],
  ["TODOU_DATABASE_PROJECTS_MAX_OPEN", ["database", "projects", "max_open"]],
  ["TODOU_DATABASE_PROJECTS_WORKERS", ["database", "projects", "workers"]],
  ["TODOU_STORAGE_BACKEND", ["storage", "backend"]],
  ["TODOU_STORAGE_PATH", ["storage", "path"]],
  ["TODOU_STORAGE_MAX_UPLOAD_MB", ["storage", "max_upload_mb"]],
];

function setPath(
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

export function loadConfig(options?: {
  configPath?: string;
  env?: Record<string, string | undefined>;
  tomlSource?: string;
}): Config {
  const env = options?.env ?? process.env;

  let raw: Record<string, unknown> = {};
  if (options?.tomlSource !== undefined) {
    raw = parseToml(options.tomlSource) as Record<string, unknown>;
  } else {
    const path = options?.configPath ?? "./todou.toml";
    try {
      raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (cause) {
      // The default path is optional; an explicitly requested file is not.
      if (options?.configPath !== undefined) {
        throw new ConfigError(`cannot read config ${path}: ${String(cause)}`);
      }
    }
  }

  for (const [name, path] of ENV_MAP) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      setPath(raw, path, value);
    }
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`invalid config: ${parsed.error.message}`);
  }
  const config = parsed.data;

  // serveStatic resolves a relative root against the process CWD, which in
  // production is the state directory rather than the checkout. Absolutising
  // here keeps the setting independent of where the server was launched from.
  if (config.http.static_dir !== undefined) {
    config.http.static_dir = resolve(config.http.static_dir);
  }

  if (config.auth.mode !== "single") {
    throw new ConfigError(
      `auth.mode="${config.auth.mode}" is not implemented yet (only "single")`,
    );
  }
  if (!isValidDbUrl(config.database.system)) {
    throw new ConfigError(
      `database.system must be a pglite:// or postgres:// URL`,
    );
  }

  let projectUrlFor: Config["projectUrlFor"] = null;
  if (config.database.projects.placement === "dedicated") {
    const template = config.database.projects.url_template;
    if (!template) {
      throw new ConfigError(
        "database.projects.url_template is required when placement is dedicated",
      );
    }
    projectUrlFor = compileUrlTemplate(template);
  }

  return { ...config, projectUrlFor };
}
