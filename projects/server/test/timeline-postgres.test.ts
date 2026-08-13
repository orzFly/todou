import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Item = {
  type: string;
  id: number;
  created_at: string;
  body?: string;
  event_type?: string;
};

const keyOf = (i: Item) =>
  i.type === "comment" ? (i.body as string) : `event:${i.event_type}`;

/** The pre-microsecond cursor format agents still hold persisted. */
function legacyCursor(item: Item): string {
  return Buffer.from(
    JSON.stringify({
      t: new Date(item.created_at).toISOString(),
      k: item.type === "comment" ? 0 : 1,
      i: item.id,
    }),
  ).toString("base64url");
}

/**
 * The regression the in-memory suite is structurally blind to: PGlite's
 * `now()` only ever produces millisecond timestamps, while real postgres
 * writes microseconds — the precision the cursor encoding used to drop.
 * These tests run against an actual postgres server (organic `defaultNow()`
 * timestamps, no backdating for the forward cases) and are skipped unless
 * TODOU_TEST_POSTGRES_URL points at one, e.g.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test timeline-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("timeline cursors on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  // The database persists across runs; a unique slug isolates each one.
  const slug = `cursor-pg-${Date.now().toString(36)}`;
  const bodies = ["b1", "b2", "b3", "b4", "b5", "b6"];
  let items: Item[] = [];

  const timeline = async (issue: number, qs: string) => {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${issue}/timeline${qs}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return json(res);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    let res = await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: "Cursor precision (postgres)" }),
    });
    expect(res.status).toBe(201);

    // Issue 1: purely organic timestamps for the forward-drain cases.
    res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Organic microsecond rows" }),
    });
    expect(res.status).toBe(201);
    for (const body of bodies) {
      const created = await t.app.request(
        `/api/projects/${slug}/issues/1/comments`,
        { method: "POST", headers, body: JSON.stringify({ body }) },
      );
      expect(created.status).toBe(201);
    }

    // Issue 2: two comments planted in one millisecond for the before= case,
    // which organic sequential writes cannot force deterministically.
    res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Shared-millisecond boundary" }),
    });
    expect(res.status).toBe(201);
    const planted: { body: string; at: string }[] = [
      { body: "d1", at: "2026-02-02T10:00:00.000100Z" },
      { body: "d2", at: "2026-02-02T10:00:00.001050Z" },
      { body: "d3", at: "2026-02-02T10:00:00.001100Z" },
      { body: "d4", at: "2026-02-02T10:00:00.002000Z" },
    ];
    const db = t.ctx.router.system();
    for (const { body, at } of planted) {
      const created = await json(
        await t.app.request(`/api/projects/${slug}/issues/2/comments`, {
          method: "POST",
          headers,
          body: JSON.stringify({ body }),
        }),
      );
      await db.execute(
        sql`update comments set created_at = ${at}::timestamptz where id = ${created.id}`,
      );
    }

    items = (await timeline(1, "?limit=100")).items;
    expect(items.map(keyOf)).toEqual(["event:opened", ...bodies]);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it("drains forward to the end without stalling on organic rows", async () => {
    const expected = ["event:opened", ...bodies];
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 12; pages += 1) {
      const page = await timeline(
        1,
        `?limit=2${after === undefined ? "" : `&after=${after}`}`,
      );
      if (page.items.length === 0) {
        expect(page.next_cursor).toBeNull();
        expect(page.has_more).toBe(false);
        break;
      }
      // The T-69 failure shape: at the end of the stream the boundary row is
      // returned again and next_cursor === after, forever.
      expect(page.next_cursor).not.toBe(after);
      seen.push(...page.items.map(keyOf));
      expect(page.has_more).toBe(seen.length < expected.length);
      after = page.next_cursor;
    }
    expect(seen).toEqual(expected);
  });

  it("project activity drains forward without stalling", async () => {
    // Issue 2's comments are backdated to 2026-02-02, so they lead; both
    // opened events and issue 1's comments follow in organic order.
    const expected = [
      "d1",
      "d2",
      "d3",
      "d4",
      "event:opened",
      ...bodies,
      "event:opened",
    ];
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 16; pages += 1) {
      const res = await t.app.request(
        `/api/projects/${slug}/activity?limit=2${after === undefined ? "" : `&after=${after}`}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      const page = await json(res);
      if (page.items.length === 0) {
        expect(page.next_cursor).toBeNull();
        expect(page.has_more).toBe(false);
        break;
      }
      expect(page.next_cursor).not.toBe(after);
      seen.push(...page.items.map(keyOf));
      expect(page.has_more).toBe(seen.length < expected.length);
      after = page.next_cursor;
    }
    expect(seen).toEqual(expected);
  });

  it("legacy ms cursors resume mid-stream without repeats or skips", async () => {
    const fromB2 = await timeline(
      1,
      `?after=${legacyCursor(items[2] as Item)}&limit=100`,
    );
    expect(fromB2.items.map(keyOf)).toEqual(["b3", "b4", "b5", "b6"]);
  });

  it("a legacy ms cursor parked at the stream's end stays parked", async () => {
    // The persisted-sentinel case: a pre-upgrade cursor at the tip of the
    // stream, whose boundary row carries organic microsecond digits.
    const page = await timeline(
      1,
      `?after=${legacyCursor(items.at(-1) as Item)}&limit=100`,
    );
    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  it("before= keeps rows sharing the boundary's millisecond", async () => {
    // Issue 2's timeline: d1..d4 (backdated), then the organic opened event.
    const tail = await timeline(2, "?last=1&limit=3");
    expect(tail.items.map(keyOf)).toEqual(["d3", "d4", "event:opened"]);
    expect(tail.prev_cursor).toBeTruthy();

    // d3's millisecond bucket also holds d2 — a truncating lt drops it.
    const page = await timeline(2, `?before=${tail.prev_cursor}&limit=10`);
    expect(page.items.map(keyOf)).toEqual(["d1", "d2"]);
    expect(page.prev_cursor).toBeNull();
  });
});
