import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "../src/db/system-schema.ts";
import { countStatements, makeRouter, makeTestApp } from "./helpers.ts";

/**
 * Self-check for the statement counter itself, and the reason it may never
 * be pointed at TODOU_TEST_POSTGRES_URL: the two drivers expose complementary
 * halves of a transaction (PGlite hides BEGIN/COMMIT from the logger and only
 * shows `set transaction`; node-postgres shows BEGIN/COMMIT and never sends
 * `set transaction`), so the absolute counts below are inline-PGlite facts,
 * not cross-driver ones.
 */
describe("statement counter", () => {
  it("counts one statement per drizzle query and attributes it to the system url", async () => {
    const t = await makeTestApp("shared");
    try {
      const cookie = await t.login();
      const log = await countStatements(t, async () => {
        await t.app.request("/api/me/inbox", { headers: { cookie } });
      });
      expect(log.total).toBeGreaterThan(0);
      expect(Object.keys(log.byUrl)).toEqual([t.ctx.config.database.system]);
    } finally {
      await t.cleanup();
    }
  });

  it("records bound params next to the sql", async () => {
    const t = await makeTestApp("shared");
    try {
      const db = t.ctx.router.system();
      const log = await countStatements(t, () =>
        db.execute(sql`select ${42}::int as a, ${"hi"}::text as b`),
      );
      const probe = log.statements.find((s) => s.sql.includes("::int"));
      expect(probe?.params).toEqual([42, "hi"]);
    } finally {
      await t.cleanup();
    }
  });

  it("cannot see begin/commit on pglite", async () => {
    const t = await makeTestApp("shared");
    try {
      const db = t.ctx.router.system();
      const log = await countStatements(t, () =>
        db.transaction(async (tx) => {
          await tx
            .insert(users)
            .values({ kind: "human", login: "tx-a", displayName: "tx-a" });
          await tx
            .insert(users)
            .values({ kind: "human", login: "tx-b", displayName: "tx-b" });
        }),
      );
      expect(log.total).toBe(2);
      expect(log.txControl).toBe(0);
    } finally {
      await t.cleanup();
    }
  });

  it("counts a configured transaction's control statement separately", async () => {
    const t = await makeTestApp("shared");
    try {
      const db = t.ctx.router.system();
      const log = await countStatements(t, () =>
        db.transaction(async (tx) => tx.execute(sql`select 1`), {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        }),
      );
      expect(log.total).toBe(1);
      // PGlite shows one control statement (`set transaction …`) and
      // node-postgres two (`begin …` + `commit`), so the floor is all that
      // can be asserted without contradicting this file's own normalisation.
      expect(log.txControl).toBeGreaterThanOrEqual(1);
    } finally {
      await t.cleanup();
    }
  });

  it("taps per-project handles the router opens lazily", async () => {
    const seen: string[] = [];
    const { config, router } = await makeRouter(
      "dedicated-bucketed",
      undefined,
      { onQuery: (_sql, _params, url) => seen.push(url) },
    );
    try {
      for (const id of [1, 2]) {
        const db = await router.provision({
          id,
          slug: `p${id}`,
          database_url: null,
        });
        await db.execute(sql`select 1`);
      }
      const urls = [1, 2].map((id) =>
        router.resolveProjectUrl({ id, slug: `p${id}`, database_url: null }),
      );
      expect(new Set(urls).size).toBe(2);
      for (const url of urls) {
        expect(url).not.toBe(config.database.system);
        expect(seen).toContain(url);
      }
    } finally {
      await router.close();
    }
  });

  it("refuses nested windows", async () => {
    const t = await makeTestApp("shared");
    try {
      await expect(
        countStatements(t, () => countStatements(t, async () => {})),
      ).rejects.toThrow(/nest/i);
    } finally {
      await t.cleanup();
    }
  });

  it("calls the caller's own onQuery first and lets its exception through", async () => {
    let armed = false;
    const t = await makeTestApp("shared", undefined, {
      onQuery: () => {
        if (armed) throw new Error("hook exploded");
      },
    });
    try {
      const db = t.ctx.router.system();
      armed = true;
      await expect(
        db
          .insert(users)
          .values({ kind: "human", login: "boom", displayName: "boom" }),
      ).rejects.toThrow("hook exploded");
      armed = false;
      const rows = await db.select().from(users);
      expect(rows.map((r) => r.login)).not.toContain("boom");
    } finally {
      await t.cleanup();
    }
  });
});
