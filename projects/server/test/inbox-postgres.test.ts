import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * Same structural blind spot as reads-postgres.test.ts, aimed at the inbox
 * candidate query: its threshold (`created_at > coalesce(last_seen_at,
 * frontier)`) must compare at full microsecond precision in SQL, or a
 * comment landing later within the read position's millisecond silently
 * never reaches the inbox. Runs only with TODOU_TEST_POSTGRES_URL set.
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("inbox unread candidates on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const slug = `inbox-pg-${Date.now().toString(36)}`;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Inbox (postgres)" }),
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
    // Mint the frontier before planting backdated rows.
    expect(
      (await t.app.request("/api/me/inbox", { headers: { cookie } })).ok,
    ).toBe(true);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it("surfaces a comment later within the last-seen millisecond", async () => {
    const created = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "microsecond inbox" }),
    });
    expect(created.status).toBe(201);
    const { number } = await json(created);

    const planted: { at: string; body: string }[] = [
      { at: "2026-03-03T10:00:00.999900Z", body: "already seen" },
      { at: "2026-03-03T10:00:01.000600Z", body: "same ms, later µs" },
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
    // Park the issue's own events well before the read position so only
    // the planted comments decide the outcome. The database persists
    // across runs and issue numbers repeat per project, so scope by the
    // project id too.
    const project = await json(
      await t.app.request(`/api/projects/${slug}`, { headers: { cookie } }),
    );
    await db.execute(
      sql`update issue_events set created_at = '2026-03-03T09:00:00Z'::timestamptz
          where issue_id in (select id from issues
                             where project_id = ${project.id}
                               and number = ${number})`,
    );

    const read = await t.app.request(
      `/api/projects/${slug}/issues/${number}/read`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ up_to: "2026-03-03T10:00:01.000Z" }),
      },
    );
    expect(read.status).toBe(204);

    // A millisecond-truncating candidate query would find nothing at all.
    const page = await json(
      await t.app.request("/api/me/inbox", { headers: { cookie } }),
    );
    const row = page.items.find(
      (i: { number: number; project: { slug: string } }) =>
        i.project.slug === slug && i.number === number,
    );
    expect(row).toBeDefined();
    expect(row.unread).toBe(true);
    expect(row.unread_comments).toBe(1);
  });

  /**
   * The other side of the same comparison, and an intentional narrowing
   * (T-278). The frontier used to reach SQL as a bound JS `Date`, which holds
   * milliseconds, while `last_seen_at` was a column reference at full
   * precision — so the two sides of one `coalesce` disagreed, and the
   * frontier side was the looser of them. Reading the frontier from a join
   * makes both sides columns.
   *
   * The behaviour change is real but narrow: `ensureFrontier` writes
   * `new Date()`, which has no microseconds to lose. Only `bulkMarkRead`
   * mints a frontier finer than a millisecond — `greatest(now(), $at)` off
   * the server clock or off a request's `up_to` — so what changes is
   * projects the reader has hit "mark all read" on, never a fresh one.
   * There, activity inside the frontier's own millisecond but before it now
   * counts as read, which is what the frontier says.
   *
   * Invisible under PGlite, which is why this lives here.
   */
  describe("a frontier's microseconds are not rounded away", () => {
    const slug2 = `inbox-pg-frontier-${Date.now().toString(36)}`;
    // Ahead of real time: `bulkMarkRead` takes `greatest(existing, up_to)`,
    // and the frontier minted below is dated now, so only a later position
    // is honoured exactly.
    const FRONTIER = "2027-04-04T10:00:00.123456Z";
    const BEFORE_US = "2027-04-04T10:00:00.123200Z";
    const AFTER_US = "2027-04-04T10:00:00.123900Z";

    beforeAll(async () => {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug: slug2, name: "Frontier (postgres)" }),
      });
      expect(created.status).toBe(201);
      const member = await t.app.request(
        `/api/projects/${slug2}/members/${bob.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);
      expect(
        (await t.app.request("/api/me/inbox", { headers: { cookie } })).ok,
      ).toBe(true);
    });

    it("counts only the comment past them, not the one inside", async () => {
      // Alice authors the card so nothing but bob's comments can decide it:
      // a card opened by someone else would count on its own (T-151).
      const created = await t.app.request(`/api/projects/${slug2}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title: "frontier microseconds" }),
      });
      expect(created.status).toBe(201);
      const { number } = await json(created);

      const db = t.ctx.router.system();
      for (const [at, body] of [
        [BEFORE_US, "inside the frontier's millisecond, before it"],
        [AFTER_US, "inside the frontier's millisecond, after it"],
      ] as const) {
        const posted = await t.app.request(
          `/api/projects/${slug2}/issues/${number}/comments`,
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

      const project = await json(
        await t.app.request(`/api/projects/${slug2}`, { headers: { cookie } }),
      );
      await db.execute(
        sql`update issue_events set created_at = '2027-04-04T09:00:00Z'::timestamptz
            where issue_id in (select id from issues
                               where project_id = ${project.id}
                                 and number = ${number})`,
      );

      // "Mark all read" is the only way to a frontier with microseconds in
      // it, and it leaves no issue_reads row for a card alice never opened,
      // so the frontier is the whole threshold.
      const marked = await t.app.request("/api/me/read", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ projects: [slug2], up_to: FRONTIER }),
      });
      expect(marked.status).toBe(204);

      const page = await json(
        await t.app.request("/api/me/inbox", { headers: { cookie } }),
      );
      const row = page.items.find(
        (i: { number: number; project: { slug: string } }) =>
          i.project.slug === slug2 && i.number === number,
      );
      // A millisecond-truncated frontier reads as `…123000Z` and lets both
      // comments through, so this said 2 before the join.
      expect(row).toBeDefined();
      expect(row.unread_comments).toBe(1);
    });
  });
});
