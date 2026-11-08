import { type ChildProcessByStdio, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { type DbTier, MIGRATION_LOCK_KEY } from "../src/db/driver.ts";
import type { DbRouter } from "../src/db/router.ts";
import { rowsFrom } from "../src/services/calendar.ts";
import { makeRouter } from "./helpers.ts";
import { createTestDatabase } from "./postgres-database.ts";
import { testTmpDir } from "./setup.ts";

/**
 * Several processes migrating one PostgreSQL database at once: servers
 * starting with auto_migrate, `todou-server migrate` run twice, or parallel
 * test files opening the same database. Concurrent migrations only collide
 * where migrations are pending, which a database earlier runs have migrated
 * no longer has, so this test makes a new database of its own instead of
 * using TODOU_TEST_POSTGRES_URL itself. Skipped unless that variable points
 * at a server; the role needs CREATEDB.
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const OPENERS = 4;
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

function journalEntries(tier: DbTier): number {
  const path = new URL(
    `../drizzle/${tier}/meta/_journal.json`,
    import.meta.url,
  );
  return (JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] })
    .entries.length;
}

async function journalRows(router: DbRouter, tier: DbTier): Promise<number> {
  const result = await router
    .system()
    .execute(
      sql.raw(
        `select count(*)::int as n from drizzle.__drizzle_migrations_${tier}`,
      ),
    );
  return Number(rowsFrom(result)[0]?.n);
}

describe.skipIf(!PG_URL)("concurrent migrations of a new database", () => {
  it("let every open return a fully migrated database", async () => {
    if (!PG_URL) throw new Error("TODOU_TEST_POSTGRES_URL is unset");
    const database = await createTestDatabase(PG_URL, "migrate_race");
    const routers: DbRouter[] = [];
    try {
      const results = await Promise.allSettled(
        Array.from({ length: OPENERS }, async () => {
          // A pool of its own per router, as separate processes would have.
          // Idle connections are never reaped, so a lock left behind on one
          // keeps every later open waiting until the test times out, instead
          // of only until the pool happens to close that connection.
          const { router } = await makeRouter("shared", {
            systemUrl: database.url,
            extraToml: "[database.pool]\nidle_timeout_ms = 0",
          });
          routers.push(router);
          // Read as soon as this open returns, not once all have: an open
          // that returned before the migration finished would only show it
          // here.
          return {
            system: await journalRows(router, "system"),
            project: await journalRows(router, "project"),
          };
        }),
      );
      const counts = results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      const expected = {
        system: journalEntries("system"),
        project: journalEntries("project"),
      };
      expect(counts).toEqual(counts.map(() => expected));
    } finally {
      await Promise.all(routers.map((router) => router.close()));
      await database.drop();
    }
  });

  // A process frozen (or cut off) while it waits must not end up holding the
  // lock: PostgreSQL would grant it to a waiter blocked in pg_advisory_lock
  // whether or not anyone is left to use it, and every later migration of the
  // database would wait on a lock nobody releases.
  it("let a migration past a queued process that froze", async ({
    onTestFinished,
  }) => {
    if (!PG_URL) throw new Error("TODOU_TEST_POSTGRES_URL is unset");
    const database = await createTestDatabase(PG_URL, "migrate_frozen");
    const holder = new pg.Client({ connectionString: database.url });
    const routers: DbRouter[] = [];
    let waiter: ChildProcessByStdio<null, Readable, null> | undefined;
    // Also runs after a timeout, which never reaches the finally below; a
    // stopped child would outlive the run.
    onTestFinished(() => {
      waiter?.kill("SIGKILL");
    });
    try {
      await holder.connect();
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [
        MIGRATION_LOCK_KEY,
      ]);
      const dir = testTmpDir("todou-migrate-");
      const configPath = join(dir, "config.toml");
      writeFileSync(
        configPath,
        `[database]\nsystem = "${database.url}"\n[storage]\npath = '${dir}'\n`,
      );
      const child = spawn(
        process.execPath,
        ["src/index.ts", "migrate", "--config", configPath],
        { cwd: SERVER_DIR, stdio: ["ignore", "pipe", "inherit"] },
      );
      waiter = child;
      const exited = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });
      await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("waiting for another migration")) resolve();
        });
        child.on("exit", () =>
          reject(new Error(`migrate exited before queueing:\n${output}`)),
        );
      });
      child.kill("SIGSTOP");
      await holder.end();

      const { router } = await makeRouter("shared", {
        systemUrl: database.url,
      });
      routers.push(router);
      expect(await journalRows(router, "system")).toBe(
        journalEntries("system"),
      );

      child.kill("SIGCONT");
      expect(await exited).toBe(0);
    } finally {
      await holder.end();
      await Promise.all(routers.map((router) => router.close()));
      await database.drop();
    }
  });
});
