import { eq } from "drizzle-orm";
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
