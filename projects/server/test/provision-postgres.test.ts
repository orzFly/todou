import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionUser } from "../src/auth/provision.ts";
import type { Db } from "../src/db/driver.ts";
import type { DbRouter } from "../src/db/router.ts";
import { users } from "../src/db/system-schema.ts";
import { makeRouter } from "./helpers.ts";

/**
 * The provisioning retry loop dispatches on the violated constraint's NAME,
 * and node-postgres shapes that error differently from PGlite — the parsing
 * in uniqueViolation() is only proven by hitting a real server. Runs only
 * when TODOU_TEST_POSTGRES_URL points at one, e.g.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54330/postgres \
 *     pnpm --filter @todou/server test provision-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("subject-keyed provisioning on real postgres", () => {
  let router: DbRouter;
  let db: Db;
  // The database persists across runs; a unique tag isolates each one.
  const tag = `pg86${Date.now().toString(36)}`;

  beforeAll(async () => {
    ({ router } = await makeRouter("shared", { systemUrl: PG_URL }));
    db = router.system();
  });

  afterAll(async () => {
    await router?.close();
  });

  async function insertUser(
    values: Partial<typeof users.$inferInsert> & { login: string },
  ) {
    const rows = await db
      .insert(users)
      .values({ kind: "human", displayName: values.login, ...values })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("user insert returned no row");
    return row;
  }

  it("suffixes past a taken login (login-index violation, pg driver)", async () => {
    const victim = await insertUser({ login: `${tag}-alice` });
    const row = await provisionUser(
      db,
      { subject: `${tag}-sub-a`, login: `${tag}-alice` },
      { autoCreate: true },
    );
    expect(row.id).not.toBe(victim.id);
    expect(row.login).toMatch(new RegExp(`^${tag}-alice-[a-z0-9]{4}$`));
    const after = await db.select().from(users).where(eq(users.id, victim.id));
    expect(after[0]).toEqual(victim);
  });

  it("returns the same-subject race winner (subject-index violation, pg driver)", async () => {
    let raced = false;
    const row = await provisionUser(
      db,
      { subject: `${tag}-race`, login: `${tag}-carol` },
      {
        autoCreate: true,
        beforeAttempt: async () => {
          if (raced) return;
          raced = true;
          await insertUser({
            login: `${tag}-winner`,
            oidcSubject: `${tag}-race`,
          });
        },
      },
    );
    expect(row.login).toBe(`${tag}-winner`);
  });

  it("retries through a colliding suffix", async () => {
    await insertUser({ login: `${tag}-bob` });
    await insertUser({ login: `${tag}-bob-aaaa` });
    const seq = ["aaaa", "bbbb"];
    const row = await provisionUser(
      db,
      { subject: `${tag}-sub-b`, login: `${tag}-bob` },
      { autoCreate: true, suffix: () => seq.shift() ?? "zzzz" },
    );
    expect(row.login).toBe(`${tag}-bob-bbbb`);
  });
});

/**
 * The first-human-is-admin check needs an empty users table, which the shared
 * database above never is again after its first run — so this suite creates a
 * disposable database (the role needs CREATEDB) and drops it afterwards.
 */
describe.skipIf(!PG_URL)("concurrent first logins on real postgres", () => {
  const name = `t632_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let router: DbRouter | undefined;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(PG_URL as string);
    url.pathname = `/${name}`;
    url.searchParams.delete("database");
    url.searchParams.delete("dbname");
    ({ router } = await makeRouter("shared", { systemUrl: url.toString() }));
  });

  afterAll(async () => {
    await router?.close();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  });

  it("makes exactly one of them instance admin", async () => {
    const db = (router as DbRouter).system();
    const racers = 8;
    // Open one pool connection per racer first, so every transaction below
    // starts on its own connection instead of queueing behind a connect.
    await Promise.all(
      Array.from({ length: racers }, () => db.execute("select 1")),
    );
    let arrived = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rows = await Promise.all(
      Array.from({ length: racers }, (_, i) =>
        provisionUser(
          db,
          { subject: `first-${i}`, login: `first${i}` },
          {
            autoCreate: true,
            beforeAttempt: async () => {
              if (++arrived === racers) release();
              await gate;
            },
          },
        ),
      ),
    );
    expect(rows.filter((row) => row.isInstanceAdmin)).toHaveLength(1);
    const stored = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isInstanceAdmin, true));
    expect(stored).toHaveLength(1);
  });
});
