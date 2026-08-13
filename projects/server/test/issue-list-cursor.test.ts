import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Item = { id: number; number: number; created_at: string };

/**
 * Byte-identical to the list cursor format servers minted before
 * microsecond precision: base64url({v: <ms toISOString>, i}). List cursors
 * are short-lived, but a Load More click can still carry one across a
 * deploy, so the new predicate must keep honoring them.
 */
function legacyCursor(item: Item): string {
  return Buffer.from(
    JSON.stringify({ v: new Date(item.created_at).toISOString(), i: item.id }),
  ).toString("base64url");
}

/**
 * Issue lists whose rows carry sub-millisecond timestamps — what a real
 * postgres `defaultNow()` produces on every insert, which PGlite's
 * millisecond-resolution clock never generates on its own. The rows are
 * backdated with explicit microsecond values so the default suite exercises
 * the same boundaries production postgres hits: cursors that truncate to
 * milliseconds make a desc page skip the boundary's millisecond-mates
 * (silent data loss) and an asc page re-match already-returned rows (dead
 * loop once a millisecond bucket holds a whole page).
 */
describe("issue list cursors across sub-millisecond rows", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "list-cursor-precision";
  // Issue numbers 1..8, created in order so ids ascend with numbers and the
  // id tie-break reproduces the true microsecond order inside a bucket.
  // 2..6 share one millisecond, 1 and 7 sit exactly on millisecond
  // boundaries (PGlite-shaped rows), 8 is a sub-millisecond stream end.
  const layout: { n: number; at: string }[] = [
    { n: 1, at: "2026-03-03T09:59:59.000000Z" },
    { n: 2, at: "2026-03-03T10:00:00.000100Z" },
    { n: 3, at: "2026-03-03T10:00:00.000200Z" },
    { n: 4, at: "2026-03-03T10:00:00.000300Z" },
    { n: 5, at: "2026-03-03T10:00:00.000400Z" },
    { n: 6, at: "2026-03-03T10:00:00.000500Z" },
    { n: 7, at: "2026-03-03T10:00:00.002000Z" },
    { n: 8, at: "2026-03-03T10:00:00.003700Z" },
  ];
  let items: Item[] = [];

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
      seen.push(...page.items.map((i: Item) => i.number));
      if (page.next_cursor === null) return seen;
      // The T-73 failure shape: a page hands back a cursor that reproduces
      // itself, so Load More can be clicked forever.
      expect(page.next_cursor).not.toBe(cursor);
      cursor = page.next_cursor;
    }
    throw new Error(`drain did not terminate in ${maxPages} pages`);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    let res = await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: "List cursor precision" }),
    });
    expect(res.status).toBe(201);
    for (const { n } of layout) {
      res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `i${n}` }),
      });
      expect(res.status).toBe(201);
    }

    // Shared placement keeps project tables in the system database, so raw
    // SQL can plant timestamps JS Dates cannot carry (µs precision). Both
    // sort columns get the same values so either exercises the predicate.
    const db = t.ctx.router.system();
    for (const { n, at } of layout) {
      await db.execute(
        sql`update issues set created_at = ${at}::timestamptz, updated_at = ${at}::timestamptz where title = ${`i${n}`}`,
      );
    }
    items = (await list("?sort=number&order=asc&limit=100")).items;
    expect(items.map((i) => i.number)).toEqual(layout.map((l) => l.n));
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("desc pages keep rows sharing the boundary's millisecond", async () => {
    // Page boundary after [6,5] lands on i5 (.000400); its millisecond
    // bucket still holds 4, 3, 2 — a truncating `lt` drops them silently.
    const seen = await drain("?sort=created&order=desc&limit=2", 8);
    expect(seen).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("asc pages advance past a same-millisecond cluster", async () => {
    // Five rows share the .000 bucket, more than one page's worth: a
    // truncating `gt` re-matches the whole bucket and never advances.
    const seen = await drain("?sort=created&order=asc&limit=2", 8);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("sort=updated walks the same boundaries", async () => {
    const seen = await drain("?sort=updated&order=desc&limit=2", 8);
    expect(seen).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("legacy ms cursors resume desc without dropping bucket-mates", async () => {
    // Old-format cursor parked on i5: the id tie-break must keep its
    // not-yet-returned millisecond-mates 4, 3, 2.
    const page = await list(
      `?sort=created&order=desc&limit=10&cursor=${legacyCursor(items[4] as Item)}`,
    );
    expect(page.items.map((i: Item) => i.number)).toEqual([4, 3, 2, 1]);
  });

  it("legacy ms cursors resume asc without re-returning the boundary", async () => {
    const page = await list(
      `?sort=created&order=asc&limit=10&cursor=${legacyCursor(items[2] as Item)}`,
    );
    expect(page.items.map((i: Item) => i.number)).toEqual([4, 5, 6, 7, 8]);
  });
});

/**
 * The shape PGlite (and thus the dogfood deployment) actually stores:
 * several rows with byte-identical millisecond timestamps. Pagination
 * inside such a cluster rests entirely on the id tie-break; this pins the
 * production list path that T-78's Load More rides on.
 */
describe("issue list cursors across identical timestamps", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "list-cursor-ties";
  const AT = "2026-03-03T12:00:00.500000Z";

  const list = async (qs: string) => {
    const res = await t.app.request(`/api/projects/${slug}/issues${qs}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    let res = await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: "List cursor ties" }),
    });
    expect(res.status).toBe(201);
    for (const n of [1, 2, 3, 4, 5]) {
      res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `t${n}` }),
      });
      expect(res.status).toBe(201);
    }
    const db = t.ctx.router.system();
    await db.execute(
      sql`update issues set created_at = ${AT}::timestamptz, updated_at = ${AT}::timestamptz where project_id = (select id from projects where slug = ${slug})`,
    );
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const drain = async (qs: string): Promise<number[]> => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 6; pages += 1) {
      const page = await list(
        `${qs}${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      );
      seen.push(...page.items.map((i: Item) => i.number));
      if (page.next_cursor === null) return seen;
      expect(page.next_cursor).not.toBe(cursor);
      cursor = page.next_cursor;
    }
    throw new Error("drain did not terminate in 6 pages");
  };

  it("asc pages split the tie cluster by id exactly once", async () => {
    expect(await drain("?sort=created&order=asc&limit=2")).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("desc pages split the tie cluster by id exactly once", async () => {
    expect(await drain("?sort=created&order=desc&limit=2")).toEqual([
      5, 4, 3, 2, 1,
    ]);
  });
});
