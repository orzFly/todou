import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * What the PGlite suite is structurally blind to (T-141). Two things only a
 * real server can answer:
 *
 *  1. migration 0010 runs at all — `CREATE EXTENSION pg_trgm` is a privilege
 *     path PGlite does not have (there the extension is linked into the WASM
 *     bundle at construction, so the statement can never fail for permission
 *     reasons);
 *  2. whether the deployment's locale lets a CJK pattern be indexed at all.
 *     Trigram extraction goes through the database's ctype: under
 *     `lc_ctype=C` a multi-byte character is not a word character, so
 *     `show_trgm('全局搜索')` comes back `{}` (measured), the pattern
 *     carries no index keys, and every Chinese query degrades to reading the
 *     whole index or the whole table. Correct, but the thing this card
 *     bought is gone, and nothing anywhere reports it. Note that the plan
 *     *shape* does not report it either — a keyless pattern still plans as a
 *     Bitmap Index Scan, just one that scans the entire index — which is why
 *     the locale check below is `show_trgm` and not an EXPLAIN.
 *
 * Runs only when TODOU_TEST_POSTGRES_URL points at a live server, e.g.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test search-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

/** Enough rows and text that ANALYZE has real statistics to plan against. */
const CORPUS_ROWS = 500;
const FILLER_REPEATS = 20;

/** node-postgres answers with a QueryResult; pglite with a bare array. */
const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
  Array.isArray(result)
    ? result
    : ((result as { rows: Array<Record<string, unknown>> }).rows ?? []);

describe.skipIf(!PG_URL)("project search on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  // The database persists across runs; a unique slug isolates each one.
  const slug = `search-pg-${Date.now().toString(36)}`;
  let projectId = 0;

  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Search (postgres)" }),
    });
    expect(created.status).toBe(201);
    projectId = (await json(created)).id;

    // One issue through the API, for a valid status id and author to clone.
    const seed = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "锚点", body: "全局搜索的实测锚点。" }),
    });
    expect(seed.status).toBe(201);

    // Bulk filler straight through SQL: 3000 issues via the API would be a
    // minute of HTTP for a fact about the planner.
    const db = t.ctx.router.system();
    await db.execute(sql`
      insert into issues (project_id, number, title, body, status_id, author_id)
      select ${projectId},
             1000 + g,
             '填充卡 ' || g,
             '编号 ' || g || ' ' ||
               repeat('与检索无关的中文正文段落，用来把表撑到真实规模。', ${FILLER_REPEATS}),
             (select status_id from issues where project_id = ${projectId} limit 1),
             (select author_id from issues where project_id = ${projectId} limit 1)
      from generate_series(1, ${CORPUS_ROWS}) as g
    `);
    await db.execute(sql`analyze issues`);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it("has pg_trgm installed by the migration", async () => {
    const rows = rowsOf(
      await t.ctx.router
        .system()
        .execute(
          sql`select extname from pg_extension where extname = 'pg_trgm'`,
        ),
    );
    expect(rows).toHaveLength(1);
  });

  it("extracts trigrams from CJK — the locale canary", async () => {
    const rows = rowsOf(
      await t.ctx.router
        .system()
        .execute(sql`select show_trgm('全局搜索')::text as trigrams`),
    );
    // `{}` here means the server's ctype does not treat these as word
    // characters, so no CJK query can ever probe the index. Measured against
    // a `lc_ctype=C` database, which is exactly what it returns there.
    expect(rows[0]?.trigrams).not.toBe("{}");
  });

  it("can answer a three-character CJK pattern from the trigram index", async () => {
    // What this pins is that the index exists on the right column under the
    // right operator class, so an ILIKE pattern can be routed to it at all —
    // the migration landing half-applied, or the opclass drifting to
    // btree, is what would break here.
    //
    // `enable_seqscan = off` because whether the planner *prefers* the index
    // is a cost trade-off that moves with table size; asserting the unforced
    // plan would make this test a barometer of how much data the run left
    // behind rather than a statement about the schema.
    const plan = await t.ctx.router.system().transaction(async (tx) => {
      // Same connection for both statements, and reverted on commit.
      await tx.execute(sql`set local enable_seqscan = off`);
      return rowsOf(
        await tx.execute(
          sql`explain select id from issues where body ilike ${"%全局搜索%"}`,
        ),
      )
        .map((r) => String(r["QUERY PLAN"]))
        .join("\n");
    });
    expect(plan).toMatch(/Bitmap Index Scan on issues_body_trgm_idx/);
    expect(plan).toMatch(/Index Cond: \(body ~~\* '%全局搜索%'::text\)/);
  });

  it("still answers a one-character CJK query correctly", async () => {
    // Below the index's reach, so this is the sequential-scan path — slow,
    // but the answer must be the same one the fast path gives.
    const res = await t.app.request(
      `/api/projects/${slug}/search?q=${encodeURIComponent("锚")}&in=issues`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { items } = await json(res);
    expect(
      items.map((i: { issue: { title: string } }) => i.issue.title),
    ).toEqual(["锚点"]);
  });

  it("searches end to end against a real server", async () => {
    const res = await t.app.request(
      `/api/projects/${slug}/search?q=${encodeURIComponent("全局搜索")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { items } = await json(res);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("issue");
    expect(items[0].field).toBe("body");
    const [start, end] = items[0].snippet.ranges[0];
    expect(items[0].snippet.text.slice(start, end)).toBe("全局搜索");
  });
});
