import { resolve } from "node:path";
import {
  ConfigError,
  flexibleBool,
  loadTomlConfig,
} from "@todou/shared/config";
import { z } from "zod";
import { compileTrustedProxies } from "./http/proxy.ts";

export { ConfigError };

const ConfigSchema = z.object({
  auth: z
    .object({
      mode: z.enum(["single", "oidc", "forward"]).default("single"),
      // Tri-state: absent = per request (https carries Secure, http does not).
      cookie_secure: flexibleBool.optional(),
      oidc: z
        .object({
          issuer: z.string().optional(),
          client_id: z.string().optional(),
          client_secret: z.string().optional(),
          scopes: z.string().default("openid profile email"),
          login_claim: z.string().default("preferred_username"),
          auto_create: flexibleBool.default(true),
        })
        .prefault({}),
      forward: z
        .object({
          user_header: z.string().optional(),
          name_header: z.string().optional(),
          email_header: z.string().optional(),
          auto_create: flexibleBool.default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  http: z
    .object({
      port: z.coerce.number().int().min(1).max(65535).default(8637),
      static_dir: z.string().optional(),
      compression: flexibleBool.default(true),
      public_origin: z.string().optional(),
      trusted_proxies: z.preprocess(
        // ENV delivers one comma-separated string; TOML delivers an array.
        (v) =>
          typeof v === "string"
            ? v
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s !== "")
            : v,
        z.array(z.string()).default(["127.0.0.1/32", "::1/128"]),
      ),
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
          // Placement-dependent default, resolved in loadConfig: dedicated
          // deployments get worker-hosted PGlite unless opted out.
          workers: flexibleBool.optional(),
        })
        .prefault({}),
      // Applied to every postgres:// pool (system and dedicated project
      // databases); pglite ignores it. Defaults mirror pg's own.
      pool: z
        .object({
          max: z.coerce.number().int().min(1).default(10),
          idle_timeout_ms: z.coerce.number().int().min(0).default(10_000),
          connection_timeout_ms: z.coerce.number().int().min(0).default(0),
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
  /** Compiled from http.trusted_proxies at load, like projectUrlFor. */
  isTrustedPeer: (addr: string) => boolean;
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

/** ENV names → config paths. ENV always wins over TOML. */
const ENV_MAP: Array<[string, string[]]> = [
  ["TODOU_AUTH_MODE", ["auth", "mode"]],
  ["TODOU_HTTP_PORT", ["http", "port"]],
  ["TODOU_HTTP_STATIC_DIR", ["http", "static_dir"]],
  ["TODOU_HTTP_COMPRESSION", ["http", "compression"]],
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
  ["TODOU_HTTP_PUBLIC_ORIGIN", ["http", "public_origin"]],
  ["TODOU_HTTP_TRUSTED_PROXIES", ["http", "trusted_proxies"]],
  ["TODOU_AUTH_COOKIE_SECURE", ["auth", "cookie_secure"]],
  ["TODOU_AUTH_OIDC_ISSUER", ["auth", "oidc", "issuer"]],
  ["TODOU_AUTH_OIDC_CLIENT_ID", ["auth", "oidc", "client_id"]],
  ["TODOU_AUTH_OIDC_CLIENT_SECRET", ["auth", "oidc", "client_secret"]],
  ["TODOU_AUTH_OIDC_SCOPES", ["auth", "oidc", "scopes"]],
  ["TODOU_AUTH_OIDC_LOGIN_CLAIM", ["auth", "oidc", "login_claim"]],
  ["TODOU_AUTH_OIDC_AUTO_CREATE", ["auth", "oidc", "auto_create"]],
  ["TODOU_AUTH_FORWARD_USER_HEADER", ["auth", "forward", "user_header"]],
  ["TODOU_AUTH_FORWARD_NAME_HEADER", ["auth", "forward", "name_header"]],
  ["TODOU_AUTH_FORWARD_EMAIL_HEADER", ["auth", "forward", "email_header"]],
  ["TODOU_AUTH_FORWARD_AUTO_CREATE", ["auth", "forward", "auto_create"]],
  ["TODOU_DATABASE_POOL_MAX", ["database", "pool", "max"]],
  ["TODOU_DATABASE_POOL_IDLE_TIMEOUT_MS", ["database", "pool", "idle_timeout_ms"]],
  [
    "TODOU_DATABASE_POOL_CONNECTION_TIMEOUT_MS",
    ["database", "pool", "connection_timeout_ms"],
  ],
];

export function loadConfig(options?: {
  configPath?: string;
  env?: Record<string, string | undefined>;
  tomlSource?: string;
}): Config {
  const config = loadTomlConfig({
    schema: ConfigSchema,
    tomlSource: options?.tomlSource,
    path: options?.configPath ?? "./todou.toml",
    // The default path is optional; an explicitly requested file is not.
    optional: options?.configPath === undefined,
    envMap: ENV_MAP,
    env: options?.env,
  });

  // serveStatic resolves a relative root against the process CWD, which in
  // production is the state directory rather than the checkout. Absolutising
  // here keeps the setting independent of where the server was launched from.
  if (config.http.static_dir !== undefined) {
    config.http.static_dir = resolve(config.http.static_dir);
  }

  if (config.auth.mode === "oidc") {
    for (const key of ["issuer", "client_id", "client_secret"] as const) {
      if (!config.auth.oidc[key]) {
        throw new ConfigError(
          `auth.oidc.${key} is required when auth.mode is "oidc"`,
        );
      }
    }
  }
  if (config.auth.mode === "forward" && !config.auth.forward.user_header) {
    throw new ConfigError(
      'auth.forward.user_header is required when auth.mode is "forward"',
    );
  }
  if (config.http.public_origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(config.http.public_origin);
    } catch {
      throw new ConfigError("http.public_origin must be an http(s) origin");
    }
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new ConfigError(
        "http.public_origin must be a bare http(s) origin (no path, query, or credentials)",
      );
    }
    config.http.public_origin = parsed.origin;
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
  config.database.projects.workers ??=
    config.database.projects.placement === "dedicated";

  // Bad entries surface at startup, not on first proxied request.
  const isTrustedPeer = compileTrustedProxies(config.http.trusted_proxies);

  return { ...config, projectUrlFor, isTrustedPeer };
}
