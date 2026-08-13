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
      // Bounds every API request body except the multipart upload routes,
      // which get storage.max_upload_mb instead. Spec pushes travel as
      // JSON, so this needs generous headroom over typical issue bodies.
      max_json_body_mb: z.coerce.number().positive().default(4),
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
      backend: z.enum(["fs", "s3"]).default("fs"),
      path: z.string().default("./data/attachments"),
      max_upload_mb: z.coerce.number().positive().default(20),
      s3: z
        .object({
          endpoint: z.string().default(""),
          // Presign target. Signatures are host-bound, so URLs handed to
          // browsers must be signed for the endpoint browsers actually
          // reach; empty falls back to `endpoint`.
          public_endpoint: z.string().default(""),
          region: z.string().default("us-east-1"),
          bucket: z.string().default(""),
          key_prefix: z.string().default(""),
          // Self-hosted stores (MinIO) generally lack the wildcard DNS
          // that virtual-host style needs.
          force_path_style: flexibleBool.default(true),
          access_key_id: z.string().default(""),
          secret_access_key: z.string().default(""),
          presign_expiry_seconds: z.coerce
            .number()
            .int()
            .positive()
            .default(300),
          // PUT presigns get a longer window: expiry is checked when the
          // upload starts, and slow links need room before that.
          upload_expiry_seconds: z.coerce
            .number()
            .int()
            .positive()
            .default(3600),
          request_timeout_ms: z.coerce
            .number()
            .int()
            .positive()
            .default(30_000),
          retries: z.coerce.number().int().min(0).default(3),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema> & {
  projectUrlFor: ((project: ProjectRouteInfo) => string) | null;
  /** Compiled from http.trusted_proxies at load, like projectUrlFor. */
  isTrustedPeer: (addr: string) => boolean;
  /** Resolved at load; null unless storage.backend is "s3". */
  s3Credentials: S3Credentials | null;
};

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Which of the three sources supplied the key pair — safe to log. */
  source: "config" | "env:TODOU_*" | "env:AWS_*";
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
  ["TODOU_HTTP_MAX_JSON_BODY_MB", ["http", "max_json_body_mb"]],
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
  [
    "TODOU_DATABASE_POOL_IDLE_TIMEOUT_MS",
    ["database", "pool", "idle_timeout_ms"],
  ],
  [
    "TODOU_DATABASE_POOL_CONNECTION_TIMEOUT_MS",
    ["database", "pool", "connection_timeout_ms"],
  ],
  ["TODOU_STORAGE_S3_ENDPOINT", ["storage", "s3", "endpoint"]],
  ["TODOU_STORAGE_S3_PUBLIC_ENDPOINT", ["storage", "s3", "public_endpoint"]],
  ["TODOU_STORAGE_S3_REGION", ["storage", "s3", "region"]],
  ["TODOU_STORAGE_S3_BUCKET", ["storage", "s3", "bucket"]],
  ["TODOU_STORAGE_S3_KEY_PREFIX", ["storage", "s3", "key_prefix"]],
  ["TODOU_STORAGE_S3_FORCE_PATH_STYLE", ["storage", "s3", "force_path_style"]],
  ["TODOU_STORAGE_S3_ACCESS_KEY_ID", ["storage", "s3", "access_key_id"]],
  [
    "TODOU_STORAGE_S3_SECRET_ACCESS_KEY",
    ["storage", "s3", "secret_access_key"],
  ],
  [
    "TODOU_STORAGE_S3_PRESIGN_EXPIRY_SECONDS",
    ["storage", "s3", "presign_expiry_seconds"],
  ],
  [
    "TODOU_STORAGE_S3_UPLOAD_EXPIRY_SECONDS",
    ["storage", "s3", "upload_expiry_seconds"],
  ],
  [
    "TODOU_STORAGE_S3_REQUEST_TIMEOUT_MS",
    ["storage", "s3", "request_timeout_ms"],
  ],
  ["TODOU_STORAGE_S3_RETRIES", ["storage", "s3", "retries"]],
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

  let s3Credentials: Config["s3Credentials"] = null;
  if (config.storage.backend === "s3") {
    s3Credentials = resolveS3Settings(config, options?.env ?? process.env);
  }

  return { ...config, projectUrlFor, isTrustedPeer, s3Credentials };
}

/**
 * Validate and normalize [storage.s3] in place, and resolve credentials.
 * loadConfig runs this when the serving backend is s3; `storage migrate`
 * calls it explicitly so an fs-serving deployment can still address the
 * s3 end of a copy.
 */
export function resolveS3Settings(
  config: Pick<z.infer<typeof ConfigSchema>, "storage">,
  env: Record<string, string | undefined> = process.env,
): S3Credentials {
  const s3 = config.storage.s3;
  for (const key of ["endpoint", "bucket"] as const) {
    if (!s3[key]) {
      throw new ConfigError(
        `storage.s3.${key} is required to use the s3 backend`,
      );
    }
  }
  for (const key of ["endpoint", "public_endpoint"] as const) {
    if (s3[key] && !/^https?:\/\/.+/.test(s3[key])) {
      throw new ConfigError(`storage.s3.${key} must be an http(s) URL`);
    }
    s3[key] = s3[key].replace(/\/+$/, "");
  }
  if (!s3.public_endpoint) s3.public_endpoint = s3.endpoint;
  if (s3.key_prefix !== "" && !s3.key_prefix.endsWith("/")) {
    s3.key_prefix += "/";
  }
  return resolveS3Credentials(s3, env);
}

/**
 * TODOU_STORAGE_S3_* env already beats TOML via ENV_MAP; what's left to
 * decide is the fallback to the standard AWS variables, so key-manager
 * tooling (vault agents, CI secrets) works without renaming. The session
 * token only ever rides along with the AWS_* pair — mixing it into
 * explicitly configured credentials would sign with mismatched halves.
 */
function resolveS3Credentials(
  s3: { access_key_id: string; secret_access_key: string },
  env: Record<string, string | undefined>,
): S3Credentials {
  if (s3.access_key_id && s3.secret_access_key) {
    const fromEnv =
      env.TODOU_STORAGE_S3_ACCESS_KEY_ID !== undefined ||
      env.TODOU_STORAGE_S3_SECRET_ACCESS_KEY !== undefined;
    return {
      accessKeyId: s3.access_key_id,
      secretAccessKey: s3.secret_access_key,
      source: fromEnv ? "env:TODOU_*" : "config",
    };
  }
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      source: "env:AWS_*",
    };
  }
  throw new ConfigError(
    "storage.s3 credentials missing: set storage.s3.access_key_id/" +
      "secret_access_key (TOML or TODOU_STORAGE_S3_*), or provide " +
      "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in the environment",
  );
}
