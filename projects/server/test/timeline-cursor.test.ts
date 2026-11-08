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

/**
 * Byte-identical to the cursor format servers minted before microsecond
 * precision: base64url({t: <ms toISOString>, k, i}). Agents persist these
 * across process restarts, so the new predicate must keep honoring them.
 */
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
 * Timelines whose rows carry sub-millisecond timestamps — what a real
 * postgres `now()` produces, which PGlite's millisecond-resolution clock
 * never generates on its own. The rows are backdated with explicit
 * microsecond values so the whole suite exercises the same boundaries the
 * production driver hits: cursors that truncate to milliseconds used to
 * make the boundary row compare after its own cursor (forward drains
 * stalled at the end of the stream) and `before=` used to skip rows
 * sharing the boundary's millisecond.
 */
describe("timeline cursors across sub-millisecond rows", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "cursor-precision";
  // Ascending timeline order; `at` is the microsecond timestamp each row is
  // backdated to. c1..c3 + the opened event share one millisecond bucket,
  // c4/c5 share the next, c6/c7 sit exactly on millisecond boundaries
  // (PGlite-shaped rows), c8 is a sub-millisecond row at the stream's end.
  const layout: { key: string; at: string }[] = [
    { key: "c1", at: "2026-02-02T10:00:00.000100Z" },
    { key: "c2", at: "2026-02-02T10:00:00.000200Z" },
    { key: "event:opened", at: "2026-02-02T10:00:00.000250Z" },
    { key: "c3", at: "2026-02-02T10:00:00.000300Z" },
    { key: "c4", at: "2026-02-02T10:00:00.001050Z" },
    { key: "c5", at: "2026-02-02T10:00:00.001100Z" },
    { key: "c6", at: "2026-02-02T10:00:00.002000Z" },
    { key: "c7", at: "2026-02-02T10:00:00.003000Z" },
    { key: "c8", at: "2026-02-02T10:00:00.003700Z" },
  ];
  const order = layout.map((l) => l.key);
  let items: Item[] = [];

  const timeline = async (qs: string) => {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/1/timeline${qs}`,
      { headers: { cookie } },
    );
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
      body: JSON.stringify({ slug, name: "Cursor precision" }),
    });
    expect(res.status).toBe(201);
    res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Sub-millisecond rows" }),
    });
    expect(res.status).toBe(201);

    const commentIds = new Map<string, number>();
    for (const { key } of layout) {
      if (key.startsWith("event:")) continue;
      const created = await json(
        await t.app.request(`/api/projects/${slug}/issues/1/comments`, {
          method: "POST",
          headers,
          body: JSON.stringify({ body: key }),
        }),
      );
      commentIds.set(key, created.id);
    }
    const opened = (await timeline("?limit=1")).items[0];
    expect(opened.event_type).toBe("opened");

    // Shared placement keeps project tables in the system database, so raw
    // SQL can plant timestamps JS Dates cannot carry (µs precision).
    const db = t.ctx.router.system();
    for (const { key, at } of layout) {
      if (key.startsWith("event:")) {
        await db.execute(
          sql`update issue_events set created_at = ${at}::timestamptz where id = ${opened.id}`,
        );
      } else {
        await db.execute(
          sql`update comments set created_at = ${at}::timestamptz where id = ${commentIds.get(key)}`,
        );
      }
    }
    items = (await timeline("?limit=100")).items;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("orders same-millisecond rows by their true timestamps", () => {
    // The opened event sits between c2 and c3 by microseconds; a merge that
    // compares at millisecond resolution shoves it behind all the comments.
    expect(items.map(keyOf)).toEqual(order);
  });

  it("drains forward to the end without stalling or repeating", async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 12; pages += 1) {
      const page = await timeline(
        `?limit=2${after === undefined ? "" : `&after=${after}`}`,
      );
      if (page.items.length === 0) {
        expect(page.next_cursor).toBeNull();
        expect(page.has_more).toBe(false);
        break;
      }
      // The T-69 failure shape: the last page's next_cursor is byte-identical
      // to the `after` that produced it, so drains spin forever.
      expect(page.next_cursor).not.toBe(after);
      seen.push(...page.items.map(keyOf));
      expect(page.has_more).toBe(seen.length < order.length);
      after = page.next_cursor;
    }
    expect(seen).toEqual(order);
  });

  it("project activity drains forward without stalling", async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 12; pages += 1) {
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
      expect(page.has_more).toBe(seen.length < order.length);
      after = page.next_cursor;
    }
    expect(seen).toEqual(order);
  });

  it("before= keeps rows that share the boundary's millisecond", async () => {
    // Backward page whose first row is c5: its cursor's millisecond bucket
    // also contains c4, which a truncating `lt` predicate used to drop.
    const tail = await timeline("?last=1&limit=4");
    expect(tail.items.map(keyOf)).toEqual(["c5", "c6", "c7", "c8"]);
    expect(tail.prev_cursor).toBeTruthy();

    const page = await timeline(`?before=${tail.prev_cursor}&limit=10`);
    expect(page.items.map(keyOf)).toEqual([
      "c1",
      "c2",
      "event:opened",
      "c3",
      "c4",
    ]);
    expect(page.prev_cursor).toBeNull();
  });

  it("legacy ms cursors resume forward without repeats or skips", async () => {
    // Mid-stream on a sub-ms row: everything after c2 exactly once, even the
    // rows inside c2's own millisecond bucket (the opened event and c3).
    const fromC2 = await timeline(`?after=${legacyCursor(items[1] as Item)}`);
    expect(fromC2.items.map(keyOf)).toEqual(order.slice(2));

    // On an exact-ms row (what PGlite data looks like) the legacy semantics
    // must hold bit-for-bit: strict continuation after c6.
    const fromC6 = await timeline(`?after=${legacyCursor(items[6] as Item)}`);
    expect(fromC6.items.map(keyOf)).toEqual(order.slice(7));
  });

  it("a legacy ms cursor parked at the stream's end stays parked", async () => {
    // The production deadloop: a persisted pre-upgrade cursor whose boundary
    // row (c8) carries sub-ms digits. It must yield an empty page and a null
    // next_cursor — not the boundary row again.
    const page = await timeline(`?after=${legacyCursor(items[8] as Item)}`);
    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  it("mints compact cursors", async () => {
    const page = await timeline("?limit=2");
    for (const cursor of [page.next_cursor, page.prev_cursor]) {
      if (cursor === null) continue;
      expect(cursor).toMatch(/^3:[0-9a-z]+\.[01]\.[0-9a-z]+$/);
      expect(cursor.length).toBeLessThan(25);
    }
  });

  it("resumes a legacy cursor onto compact ones without a seam", async () => {
    // The live upgrade path: an agent's persisted version-1 cursor resumes,
    // and every cursor it hands back from then on is the compact form.
    const seen: string[] = [];
    let after = legacyCursor(items[1] as Item);
    for (let pages = 0; pages < 12; pages += 1) {
      const page = await timeline(`?limit=2&after=${after}`);
      if (page.items.length === 0) break;
      seen.push(...page.items.map(keyOf));
      expect(page.next_cursor.startsWith("3:")).toBe(true);
      after = page.next_cursor;
    }
    expect(seen).toEqual(order.slice(2));
  });

  it("legacy ms cursors page backward without loss", async () => {
    // Boundary c5 shares its millisecond with c4; the legacy encoding cannot
    // order them by time, so the (kind, id) tie-break must keep c4.
    const page = await timeline(
      `?before=${legacyCursor(items[5] as Item)}&limit=10`,
    );
    expect(page.items.map(keyOf)).toEqual(order.slice(0, 5));
  });

  it("per-item cursors resume inside a shared millisecond (T-667)", async () => {
    await expectItemCursorsResume(timeline, keyOf);
  });
});

/**
 * Per-item cursors (T-667) on one endpoint: resuming from any item delivers
 * exactly what follows it, forward and backward pages alike, and the forward
 * page's last item is its `next_cursor`. `read` takes a query string.
 */
async function expectItemCursorsResume(
  // biome-ignore lint/suspicious/noExplicitAny: test-side response poking
  read: (qs: string) => Promise<any>,
  keyOf: (i: Item) => string,
): Promise<void> {
  const page = await read("?limit=100");
  const all: (Item & { cursor?: string })[] = page.items;
  expect(all.length).toBeGreaterThanOrEqual(3);
  const keys = all.map(keyOf);
  for (const [k, item] of all.entries()) {
    expect(item.cursor).toMatch(/^3:/);
    const after = await read(`?limit=100&after=${item.cursor}`);
    expect(after.items.map(keyOf)).toEqual(keys.slice(k + 1));
  }
  expect(all.at(-1)?.cursor).toBe(page.next_cursor);

  const tail = await read("?last=1&limit=2");
  expect(tail.items.map(keyOf)).toEqual(keys.slice(-2));
  for (const [j, item] of (tail.items as Item[]).entries()) {
    const k = keys.length - 2 + j;
    expect((item as Item & { cursor?: string }).cursor).toBe(all[k]?.cursor);
  }
}

describe("per-item cursors (T-667)", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "item-cursors";
  const headers = () => ({ "content-type": "application/json", cookie });

  const read = (path: string) => async (qs: string) => {
    const res = await t.app.request(`/api/projects/${slug}${path}${qs}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };
  const timeline = read("/issues/1/timeline");
  const activity = read("/activity");

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    let res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Item cursors" }),
    });
    expect(res.status).toBe(201);
    res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Cursors per entry" }),
    });
    expect(res.status).toBe(201);
    const statuses: { id: number; name: string }[] = await json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: { cookie },
      }),
    );
    const doing = statuses.find((s) => s.name === "In Progress");
    const writes: [string, unknown][] = [
      ["comments", { body: "x1" }],
      // One transaction: the comment and the status change share a
      // timestamp, so only the (kind, id) tie-break orders them.
      [
        "commands",
        { body: "x2", commands: [{ type: "status", status_id: doing?.id }] },
      ],
      ["comments", { body: "x3" }],
    ];
    for (const [path, body] of writes) {
      res = await t.app.request(`/api/projects/${slug}/issues/1/${path}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      expect(res.ok).toBe(true);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("orders a comment and an event written by one request", async () => {
    const items: Item[] = (await timeline("?limit=100")).items;
    expect(items.map(keyOf)).toEqual([
      "event:opened",
      "x1",
      "x2",
      "event:status_changed",
      "x3",
    ]);
    expect(items[2]?.created_at).toBe(items[3]?.created_at);
  });

  it("issue timeline: every item resumes right after itself", async () => {
    await expectItemCursorsResume(timeline, keyOf);
  });

  it("project activity: every item resumes right after itself", async () => {
    await expectItemCursorsResume(activity, keyOf);
  });

  it("before= an item's cursor pages back from it", async () => {
    const items: (Item & { cursor: string })[] = (await timeline("?limit=100"))
      .items;
    const page = await timeline(`?before=${items[3]?.cursor}&limit=100`);
    expect(page.items.map(keyOf)).toEqual(items.slice(0, 3).map(keyOf));
  });
});
