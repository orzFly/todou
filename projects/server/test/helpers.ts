import { type App, createApp } from "../src/app.ts";
import {
  type AppContext,
  bootstrap,
  type TestHooks,
} from "../src/bootstrap.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { DbRouter, type DbTestHooks } from "../src/db/router.ts";
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
  hooks?: DbTestHooks,
): Promise<{ config: Config; router: DbRouter }> {
  const config = testConfig(placement, overrides);
  const router = await DbRouter.open(config, hooks);
  return { config, router };
}

type Sink = (sql: string, params: unknown[], url: string) => void;
type CounterSlot = { sink: Sink | null };

const counters = new WeakMap<AppContext, CounterSlot>();

export type StatementLog = {
  total: number;
  byUrl: Record<string, number>;
  txControl: number;
  statements: {
    sql: string;
    params: unknown[];
    url: string;
    txControl: boolean;
  }[];
};

// Transaction control is counted apart from the rest because the two drivers
// expose complementary halves of it: PGlite delegates BEGIN/COMMIT to the
// client so only `set transaction` reaches the logger, while node-postgres
// sends BEGIN/COMMIT through the logger and no `set transaction` at all.
// Folding them into one total makes the same assertion disagree with itself
// between the default run and TODOU_TEST_POSTGRES_URL.
const TX_CONTROL =
  /^\s*(begin|commit|rollback|savepoint|release savepoint|rollback to savepoint|set transaction)\b/i;

export async function countStatements(
  t: TestApp,
  fn: () => Promise<unknown>,
): Promise<StatementLog> {
  const slot = counters.get(t.ctx);
  if (!slot) throw new Error("countStatements needs an app from makeTestApp");
  if (slot.sink) {
    throw new Error("countStatements windows cannot nest or run concurrently");
  }
  const log: StatementLog = {
    total: 0,
    byUrl: {},
    txControl: 0,
    statements: [],
  };
  slot.sink = (sql, params, url) => {
    const txControl = TX_CONTROL.test(sql);
    log.statements.push({ sql, params, url, txControl });
    if (txControl) {
      log.txControl += 1;
      return;
    }
    log.total += 1;
    log.byUrl[url] = (log.byUrl[url] ?? 0) + 1;
  };
  try {
    await fn();
  } finally {
    slot.sink = null;
  }
  return log;
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
  testHooks?: TestHooks,
): Promise<TestApp> {
  const config = testConfig(placement, overrides);
  // Installed unconditionally because installing it means rebuilding the
  // whole app: making it per-fixture would force countStatements to grow a
  // second constructor. With no window open each statement costs one closure
  // call and one null check, which is what drizzle's NoopLogger cost anyway,
  // and production never reaches this file.
  const slot: CounterSlot = { sink: null };
  const ctx = await bootstrap(config, {
    ...testHooks,
    onQuery: (sql, params, url) => {
      // The caller's hook runs first and is deliberately not wrapped: the
      // fault-injection tests prove rollback by throwing from here, which
      // only works if the exception reaches the statement's call site.
      testHooks?.onQuery?.(sql, params, url);
      slot.sink?.(sql, params, url);
    },
  });
  counters.set(ctx, slot);
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
