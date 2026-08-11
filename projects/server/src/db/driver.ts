import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";

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

export async function openDb(url: string): Promise<DbHandle> {
  const kind = dbKindOf(url);
  if (kind === "pglite") {
    // "pglite://memory" (with optional suffix for distinct instances) is
    // in-memory; anything else is a data directory path.
    const target = url.slice("pglite://".length);
    const client = target.startsWith("memory")
      ? new PGlite()
      : new PGlite(target);
    const db = drizzlePglite(client);
    return {
      db: db as unknown as Db,
      kind,
      url,
      migrate: (tier) => migratePglite(db, MIGRATIONS[tier]),
      close: () => client.close(),
    };
  }
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzleNodePg(pool);
  return {
    db: db as unknown as Db,
    kind,
    url,
    migrate: (tier) => migrateNodePg(db, MIGRATIONS[tier]),
    close: () => pool.end(),
  };
}
