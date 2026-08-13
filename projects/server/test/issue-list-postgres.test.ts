import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The list-cursor regression the in-memory suite is structurally blind to:
 * PGlite's clock only ever produces millisecond timestamps, while real
 * postgres writes microseconds into `issues.created_at` on every insert —
 * the precision the cursor encoding used to drop. Runs only when
 * TODOU_TEST_POSTGRES_URL points at a live server, e.g.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test issue-list-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("issue list cursors on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  // The database persists across runs; a unique slug isolates each one.
  const slug = `list-pg-${Date.now().toString(36)}`;
  let projectId = 0;

  const list = async (qs: string) => {
    const res = await t.app.request(`/api/projects/${slug}/issues${qs}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  /** Follow next_cursor to the end; throws if the walk stops advancing. */
  const drain = async (qs: string, maxPages: number): Promise<number[]> => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < maxPages; pages += 1) {
      const page = await list(
        `${qs}${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      );
      seen.push(...page.items.map((i: { number: number }) => i.number));
      if (page.next_cursor === null) return seen;
      // The T-73 failure shape: with `limit` ≤ the millisecond bucket size
      // the next page reproduces its own input cursor, forever.
      expect(page.next_cursor).not.toBe(cursor);
      cursor = page.next_cursor;
    }
    throw new Error(`drain did not terminate in ${maxPages} pages`);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: "List cursors (postgres)" }),
    });
    expect(res.status).toBe(201);
    projectId = (await json(res)).id;

    // Issues 1..6: purely organic defaultNow() timestamps — on postgres
    // effectively every row carries sub-millisecond digits.
    for (let n = 1; n <= 6; n += 1) {
      const created = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `organic ${n}` }),
      });
      expect(created.status).toBe(201);
    }

    // Issues 7..10: one millisecond bucket with distinct microseconds,
    // which organic sequential inserts cannot force deterministically.
    // Backdated, so in desc order they trail the organic rows.
    const planted: { n: number; at: string }[] = [
      { n: 7, at: "2026-03-03T10:00:01.000100Z" },
      { n: 8, at: "2026-03-03T10:00:01.000200Z" },
      { n: 9, at: "2026-03-03T10:00:01.000300Z" },
      { n: 10, at: "2026-03-03T10:00:01.000400Z" },
    ];
    const db = t.ctx.router.system();
    for (const { n, at } of planted) {
      const created = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `planted ${n}` }),
      });
      expect(created.status).toBe(201);
      await db.execute(
        sql`update issues set created_at = ${at}::timestamptz where project_id = ${projectId} and number = ${n}`,
      );
    }
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it("asc drain with limit=1 never re-returns a boundary row", async () => {
    // Every organic boundary row sits above its own millisecond floor, so a
    // truncating `gt` matches it again: [1],[1],[1]… with the same cursor.
    const seen = await drain("?sort=created&order=asc&limit=1", 12);
    expect(seen).toEqual([7, 8, 9, 10, 1, 2, 3, 4, 5, 6]);
  });

  it("desc drain keeps rows sharing a boundary's millisecond", async () => {
    // Page boundary after [10,9] lands mid-bucket; a truncating `lt`
    // silently drops 8 and 7 — data loss on the default list path.
    const seen = await drain("?sort=created&order=desc&limit=2", 8);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1, 10, 9, 8, 7]);
  });
});
