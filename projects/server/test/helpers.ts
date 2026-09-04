import { type App, createApp } from "../src/app.ts";
import { type AppContext, bootstrap } from "../src/bootstrap.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { DbRouter } from "../src/db/router.ts";
import { users } from "../src/db/system-schema.ts";
import { issueToken } from "../src/services/tokens.ts";
import { testTmpDir } from "./setup.ts";

export type PlacementMode = "shared" | "dedicated" | "dedicated-bucketed";

export const PLACEMENTS: PlacementMode[] = [
  "shared",
  "dedicated",
  "dedicated-bucketed",
];

let instance = 0;

/**
 * In-memory config for one test suite. Each call gets distinct pglite
 * memory URLs so suites never share state. "dedicated-bucketed" exercises
 * a user-written ${} expression that maps several projects onto one target.
 */
export type ConfigOverrides = {
  maxOpen?: number;
  urlTemplate?: string;
  maxUploadMb?: number;
  workers?: boolean;
  staticDir?: string;
  cliDistDir?: string;
  /** Raw TOML prepended to the generated document (auth sections etc.). */
  extraToml?: string;
  /** Point storage at a fake S3 (see fake-s3.ts); backend flips to "s3". */
  s3?: { endpoint: string; publicEndpoint?: string; keyPrefix?: string };
  /**
   * Real database URL for the system tier instead of per-run pglite memory.
   * Postgres URLs also get auto_migrate switched on, which the production
   * default leaves off for that driver.
   */
  systemUrl?: string;
};

export function testConfig(
  placement: PlacementMode = "shared",
  overrides?: ConfigOverrides,
): Config {
  const run = `r${instance++}`;
  const storageDir = testTmpDir("todou-storage-");
  const lines = [
    "[storage]",
    `backend = '${overrides?.s3 ? "s3" : "fs"}'`,
    `path = '${storageDir}'`,
    `max_upload_mb = ${overrides?.maxUploadMb ?? 20}`,
    "[database]",
    `system = "${overrides?.systemUrl ?? `pglite://memory/${run}-system`}"`,
    ...(overrides?.systemUrl?.startsWith("postgres")
      ? ["auto_migrate = true"]
      : []),
    "[database.projects]",
  ];
  if (placement === "shared") {
    lines.push('placement = "shared"');
  } else {
    const template =
      overrides?.urlTemplate ??
      (placement === "dedicated"
        ? `pglite://memory/${run}-p\${project.id}`
        : `pglite://memory/${run}-b\${project.id % 2}`);
    lines.push('placement = "dedicated"');
    lines.push(`url_template = '${template}'`);
  }
  if (overrides?.maxOpen) {
    lines.push(`max_open = ${overrides.maxOpen}`);
  }
  // Always explicit: the production default (workers on under dedicated
  // placement) would otherwise put every dedicated suite in worker mode.
  lines.push(`workers = ${overrides?.workers ?? false}`);
  const http: string[] = [];
  if (overrides?.staticDir) {
    http.push(`static_dir = '${overrides.staticDir}'`);
  }
  if (overrides?.cliDistDir) {
    http.push(`cli_dist_dir = '${overrides.cliDistDir}'`);
  }
  if (http.length > 0) {
    lines.unshift("[http]", ...http);
  }
  if (overrides?.extraToml) {
    lines.unshift(overrides.extraToml);
  }
  if (overrides?.s3) {
    lines.push(
      "[storage.s3]",
      `endpoint = '${overrides.s3.endpoint}'`,
      "bucket = 'test-bucket'",
      "access_key_id = 'test-ak'",
      "secret_access_key = 'test-sk'",
      "retries = 2",
      "request_timeout_ms = 2000",
    );
    if (overrides.s3.publicEndpoint) {
      lines.push(`public_endpoint = '${overrides.s3.publicEndpoint}'`);
    }
    if (overrides.s3.keyPrefix) {
      lines.push(`key_prefix = '${overrides.s3.keyPrefix}'`);
    }
  }
  return loadConfig({ tomlSource: lines.join("\n"), env: {} });
}

export async function makeRouter(
  placement: PlacementMode = "shared",
  overrides?: ConfigOverrides,
): Promise<{ config: Config; router: DbRouter }> {
  const config = testConfig(placement, overrides);
  const router = await DbRouter.open(config);
  return { config, router };
}

export type TestApp = {
  app: App;
  ctx: AppContext;
  /** POST /api/auth/login and return a Cookie header value. */
  login: () => Promise<string>;
  cleanup: () => Promise<void>;
};

export async function makeTestApp(
  placement: PlacementMode = "shared",
  overrides?: ConfigOverrides,
  testHooks?: AppContext["testHooks"],
): Promise<TestApp> {
  const config = testConfig(placement, overrides);
  const ctx = await bootstrap(config);
  if (testHooks !== undefined) ctx.testHooks = testHooks;
  const app = createApp(ctx);
  return {
    app,
    ctx,
    login: async () => {
      const res = await app.request("/api/auth/login", { method: "POST" });
      if (res.status !== 200) {
        throw new Error(`login failed: ${res.status}`);
      }
      const setCookie = res.headers.get("set-cookie");
      if (!setCookie) throw new Error("login did not set a cookie");
      return setCookie.split(";")[0] as string;
    },
    cleanup: () => ctx.router.close(),
  };
}

/** Insert an extra user and mint a PAT so tests can act as them. */
export async function addUserWithToken(
  ctx: AppContext,
  login: string,
  opts?: {
    kind?: "human" | "machine";
    ownerId?: number;
    instanceAdmin?: boolean;
  },
): Promise<{
  user: typeof users.$inferSelect;
  headers: { authorization: string };
}> {
  const inserted = await ctx.router
    .system()
    .insert(users)
    .values({
      kind: opts?.kind ?? "human",
      login,
      displayName: login,
      ownerId: opts?.ownerId ?? null,
      isInstanceAdmin: opts?.instanceAdmin ?? false,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("user insert returned no row");
  const token = await issueToken(ctx.router.system(), row.id, {
    name: `${login}-token`,
  });
  return { user: row, headers: { authorization: `Bearer ${token.token}` } };
}
