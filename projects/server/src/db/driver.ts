import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Logger } from "drizzle-orm/logger";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { PGLITE_EXTENSIONS } from "./pglite-extensions.ts";
import { WorkerPgliteClient } from "./worker-client.ts";

/** Driver-agnostic database type both pglite and node-postgres satisfy. */
export type Db = PgDatabase<PgQueryResultHKT>;

export type DbKind = "pglite" | "postgres";
export type DbTier = "system" | "project";

export type DbHandle = {
  db: Db;
  kind: DbKind;
  url: string;
  migrate: (tier: DbTier) => Promise<void>;
  close: () => Promise<void>;
};

// Each tier keeps its own journal table: in shared placement both tiers
// live in one database, and a common journal would let one tier's newer
// timestamps mask the other tier's pending migrations.
const MIGRATIONS: Record<
  DbTier,
  { migrationsFolder: string; migrationsTable: string }
> = {
  system: {
    migrationsFolder: fileURLToPath(
      new URL("../../drizzle/system", import.meta.url),
    ),
    migrationsTable: "__drizzle_migrations_system",
  },
  project: {
    migrationsFolder: fileURLToPath(
      new URL("../../drizzle/project", import.meta.url),
    ),
    migrationsTable: "__drizzle_migrations_project",
  },
};

export function dbKindOf(url: string): DbKind {
  if (url.startsWith("pglite://")) return "pglite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgres";
  }
  throw new Error(`unsupported database URL: ${url}`);
}

export type PoolOptions = {
  max: number;
  idle_timeout_ms: number;
  connection_timeout_ms: number;
};

export type OpenDbOptions = {
  workerHost?: boolean;
  pool?: PoolOptions;
  logger?: Logger;
  /**
   * The tiers the caller is about to migrate this database to. Read only for
   * in-memory PGlite, where it selects a pre-migrated template instead of a
   * fresh initdb; the caller's own `migrate` calls then cost ~8ms and stay
   * the authority on what ran. Leave it out when the caller will not migrate
   * at all, which is what `auto_migrate = false` asks for.
   */
  tiers?: DbTier[];
};

export async function openDb(
  url: string,
  opts?: OpenDbOptions,
): Promise<DbHandle> {
  const kind = dbKindOf(url);
  if (kind === "pglite") {
    // "pglite://memory" (with optional suffix for distinct instances) is
    // in-memory; anything else is a data directory path.
    const target = url.slice("pglite://".length);
    const isMemory = target.startsWith("memory");
    // PGlite fails obscurely on first query when the data directory's
    // parents don't exist yet.
    if (!isMemory) await mkdir(target, { recursive: true });
    // Worker host: PGlite lives in a worker thread and the proxy
    // satisfies drizzle's query surface, so per-project databases
    // execute on separate cores.
    const client = opts?.workerHost
      ? (new WorkerPgliteClient(
          isMemory ? undefined : target,
        ) as unknown as PGlite)
      : isMemory
        ? await memoryClient(opts?.tiers ?? [])
        : new PGlite(target, { extensions: PGLITE_EXTENSIONS });
    const db = drizzlePglite(client, { logger: opts?.logger });
    return {
      db: db as unknown as Db,
      kind,
      url,
      migrate: (tier) => migratePglite(db, MIGRATIONS[tier]),
      close: () => client.close(),
    };
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: opts?.pool?.max,
    idleTimeoutMillis: opts?.pool?.idle_timeout_ms,
    connectionTimeoutMillis: opts?.pool?.connection_timeout_ms,
  });
  const db = drizzleNodePg(pool, { logger: opts?.logger });
  return {
    db: db as unknown as Db,
    kind,
    url,
    migrate: (tier) => migrateNodePgQueued(pool, tier, opts?.logger),
    close: () => pool.end(),
  };
}

// Advisory locks belong to one database, so a fixed key queues the
// migrations of that database and no other. Both tiers take the same key:
// their journals live in the one "drizzle" schema that each migration starts
// by creating. The value is "todou" in ASCII; any fixed number would do.
export const MIGRATION_LOCK_KEY = 0x746f646f75;
const MIGRATION_LOCK_RETRY_MS = 1_000;

/**
 * drizzle's migrator cannot run twice at once on one database. It creates
 * the "drizzle" schema and the journal table and reads the last journal entry
 * outside any transaction, and only then applies the newer migrations in
 * one. Two runs on a database with migrations pending collide on the
 * catalogs' unique indexes (IF NOT EXISTS sees only what is committed), or
 * both apply the same migrations and the later commit fails. Two servers
 * starting with auto_migrate do that, as do two `todou-server migrate` or two
 * test files opening one new database.
 *
 * So a migration first takes a session advisory lock on a connection of its
 * own and runs on that connection; another one tries again every second
 * until it gets the lock, then finds the journal current. The connection is
 * closed afterwards instead of going back to the pool, whether the migration
 * succeeded or threw: a pooled connection still holding the lock (an unlock
 * an error skipped) would hold up every later migration of the database
 * until the pool closed it, which on a busy server may be never. Ending the
 * session releases the lock the same way on both paths. All of it needs one
 * server session throughout, which a transaction-pooling proxy does not give
 * (see docs/deploy.md).
 *
 * It retries rather than blocking in pg_advisory_lock. PostgreSQL grants a
 * blocked waiter the lock even when its process has frozen or died meanwhile,
 * as it notices a dead client only on its next read, and that waiter would
 * then hold up every later migration. A blocking statement also falls under
 * a role's lock_timeout or statement_timeout, and leaves the connection
 * silent for whatever idle timeout lies on the network path.
 *
 * The wait has no timeout. A short one would fail a process queued behind a
 * long but healthy migration, and the case it would rescue, a holder whose
 * machine vanished, lasts until TCP keepalive notices, by default hours.
 * Waiting is logged instead, so a start that hangs says why.
 */
async function migrateNodePgQueued(
  pool: pg.Pool,
  tier: DbTier,
  logger: Logger | undefined,
): Promise<void> {
  const client = await pool.connect();
  const tryLock = async () => {
    const { rows } = await client.query<{ locked: boolean; name: string }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked, current_database() AS name",
      [MIGRATION_LOCK_KEY],
    );
    return rows[0];
  };
  try {
    let attempt = await tryLock();
    if (!attempt?.locked) {
      console.log(
        `migrate: waiting for another migration of database "${attempt?.name}" (${tier} tier)`,
      );
      while (!attempt?.locked) {
        await delay(MIGRATION_LOCK_RETRY_MS);
        attempt = await tryLock();
      }
    }
    await migrateNodePg(drizzleNodePg(client, { logger }), MIGRATIONS[tier]);
  } finally {
    client.release(true);
  }
}

type MemoryTemplate = {
  dump: Awaited<ReturnType<PGlite["dumpDataDir"]>>;
  /** The instance the dump was taken from, until somebody claims it. */
  seed: PGlite | null;
};

/**
 * Pre-migrated in-memory databases, keyed by the tiers they carry.
 *
 * `new PGlite()` on a memory URL runs a full initdb inside the WASM build on
 * its first query — measured at ~1.8s, and the second instance in a process
 * costs the same as the first, because only the WASM module compile is
 * cached. Restoring a dump of an already-migrated instance costs ~0.4s and
 * brings the migrations with it. Only tests open memory URLs (a deployment
 * names a data directory, see docs/deploy.md), and there one test file stands
 * up three of these per test case.
 *
 * Whoever builds a template is handed the seed instance itself, so the first
 * database of a tier set pays the ~0.1s dump and nothing else on top of the
 * initdb it already owed; every later one pays ~0.4s instead of ~1.8s.
 *
 * Migrating the seed deliberately bypasses the caller's `logger`: routed
 * through it, the migration DDL would reach the query tap of whichever test
 * happened to run first in a fork and of no other, which would make a
 * statement count depend on test order.
 */
const memoryTemplates = new Map<string, Promise<MemoryTemplate>>();

async function buildMemoryTemplate(tiers: DbTier[]): Promise<MemoryTemplate> {
  const seed = new PGlite({ extensions: PGLITE_EXTENSIONS });
  const db = drizzlePglite(seed);
  for (const tier of tiers) await migratePglite(db, MIGRATIONS[tier]);
  // Uncompressed: gzip trades ~1.5s of dump and ~0.5s of every restore for
  // 36 MiB of resident size per template, and time is the whole point here.
  return { dump: await seed.dumpDataDir("none"), seed };
}

async function memoryClient(tiers: DbTier[]): Promise<PGlite> {
  if (tiers.length === 0) return new PGlite({ extensions: PGLITE_EXTENSIONS });
  const key = tiers.join("+");
  let building = memoryTemplates.get(key);
  if (!building) {
    building = buildMemoryTemplate(tiers);
    // A rejected build must not stay cached: one failing migration would
    // otherwise become every later open in the process failing, with the
    // original stack attached to a call that did nothing wrong.
    building.catch(() => memoryTemplates.delete(key));
    memoryTemplates.set(key, building);
  }
  const template = await building;
  if (template.seed) {
    const seed = template.seed;
    template.seed = null;
    return seed;
  }
  return new PGlite({
    loadDataDir: template.dump,
    extensions: PGLITE_EXTENSIONS,
  });
}
