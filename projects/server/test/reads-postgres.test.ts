import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The unread-count regression the in-memory suite is structurally blind to:
 * PGlite's clock only ever produces millisecond timestamps, while real
 * postgres stores microseconds in `comments.created_at` — and `last_seen_at`
 * comes from a millisecond JS Date, so a comment landing later in the same
 * millisecond is only unread if the threshold compares at full precision
 * in SQL (T-77). Runs only when TODOU_TEST_POSTGRES_URL points at a live
 * server, e.g.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test reads-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("unread comment counts on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  // The database persists across runs; a unique slug isolates each one.
  const slug = `reads-pg-${Date.now().toString(36)}`;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Reads (postgres)" }),
    });
    expect(res.status).toBe(201);
    bob = await addUserWithToken(t.ctx, `bob-${slug}`);
    const member = await t.app.request(
      `/api/projects/${slug}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it("counts sub-millisecond mates of the last-seen position", async () => {
    const created = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "microsecond ledger" }),
    });
    expect(created.status).toBe(201);
    const { number } = await json(created);

    // Three foreign comments backdated around the last-seen millisecond:
    // one 100µs before it, two later inside the very same millisecond.
    const planted: { at: string; body: string }[] = [
      { at: "2026-03-03T10:00:00.999900Z", body: "already seen" },
      { at: "2026-03-03T10:00:01.000200Z", body: "same ms, later µs" },
      { at: "2026-03-03T10:00:01.000700Z", body: "same ms, latest µs" },
    ];
    const db = t.ctx.router.system();
    for (const { at, body } of planted) {
      const posted = await t.app.request(
        `/api/projects/${slug}/issues/${number}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ body }),
        },
      );
      expect(posted.status).toBe(201);
      const { id } = await json(posted);
      await db.execute(
        sql`update comments set created_at = ${at}::timestamptz where id = ${id}`,
      );
    }

    // Read position at the millisecond boundary — a JS Date can't say finer.
    const read = await t.app.request(
      `/api/projects/${slug}/issues/${number}/read`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ up_to: "2026-03-03T10:00:01.000Z" }),
      },
    );
    expect(read.status).toBe(204);

    // A millisecond-truncating comparison would see all three as read.
    const page = await json(
      await t.app.request(`/api/projects/${slug}/issues?numbers=${number}`, {
        headers: { cookie },
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].unread).toBe(true);
    expect(page.items[0].unread_comments).toBe(2);
  });

  it("counts a top post inside the last-seen millisecond (T-151)", async () => {
    // Same blind spot, now on `issues.created_at`: the card's own threshold
    // must be compared in SQL too, or a card opened microseconds after the
    // read position reads as already seen.
    const created = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bob.headers },
      body: JSON.stringify({ title: "microsecond card" }),
    });
    expect(created.status).toBe(201);
    const { id, number } = await json(created);
    await t.ctx.router
      .system()
      .execute(
        sql`update issues set created_at = '2026-04-04T10:00:01.000700Z'::timestamptz where id = ${id}`,
      );

    const read = await t.app.request(
      `/api/projects/${slug}/issues/${number}/read`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ up_to: "2026-04-04T10:00:01.000Z" }),
      },
    );
    expect(read.status).toBe(204);

    const page = await json(
      await t.app.request(`/api/projects/${slug}/issues?numbers=${number}`, {
        headers: { cookie },
      }),
    );
    expect(page.items).toHaveLength(1);
    // Truncating to the millisecond would tie, and a tie is not "after".
    expect(page.items[0].unread_comments).toBe(1);
  });
});
