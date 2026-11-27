import { PROJECT_NOT_FOUND } from "@todou/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The precision half of T-100 that the in-memory suite cannot see: PGlite's
 * clock only ever produces millisecond timestamps, so a sweep position that
 * silently rounds to the millisecond looks correct there. Real postgres
 * stores microseconds, and the bulk sweep binds `up_to` as a string on
 * purpose — routing it through a JS Date (as the single-issue endpoint
 * does) would truncate it and clear comments the caller never asked to
 * clear. Runs only when TODOU_TEST_POSTGRES_URL points at a live server:
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test bulk-read-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("bulk mark-as-read on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  let meId: number;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  // The database persists across runs; a unique slug isolates each one.
  const slug = `bulk-pg-${Date.now().toString(36)}`;
  const headers = () => ({ "content-type": "application/json", cookie });

  const EPOCH = "2026-03-03T10:00:00.000000Z";
  // A microsecond apart inside one millisecond, for the per-issue layer,
  // which compares in SQL at full precision.
  const US_BEFORE = "2026-03-03T10:00:01.000200Z";
  const US_AFTER = "2026-03-03T10:00:01.000700Z";
  const US_CUT = "2026-03-03T10:00:01.000500Z";
  // Milliseconds apart, for the frontier layer: `unreadIssueState` reads
  // the frontier into a JS Date before comparing, so its threshold is only
  // ever millisecond-grained (noted on the card as a separate wrinkle).
  const MS_BEFORE = "2026-03-03T10:00:02.100000Z";
  const MS_AFTER = "2026-03-03T10:00:02.300000Z";
  const MS_CUT = "2026-03-03T10:00:02.200000Z";

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    meId = (await json(await t.app.request("/api/me", { headers: { cookie } })))
      .id;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Bulk read (postgres)" }),
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

  async function createIssue(title: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  /** Two foreign comments, backdated to either side of a cut. */
  async function plant(number: number, ats: string[]): Promise<void> {
    const db = t.ctx.router.system();
    for (const at of ats) {
      const posted = await t.app.request(
        `/api/projects/${slug}/issues/${number}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ body: `planted at ${at}` }),
        },
      );
      expect(posted.status).toBe(201);
      const { id } = await json(posted);
      await db.execute(
        sql`update comments set created_at = ${at}::timestamptz where id = ${id}`,
      );
    }
  }

  /**
   * Drag my frontier back to `at`. The row is minted lazily by the first
   * list call, which dates it well after the planted comments — without
   * this every frontier-path issue would read as ancient history.
   */
  async function backdateFrontier(at: string): Promise<void> {
    await t.ctx.router
      .system()
      .execute(
        sql`update read_frontiers set frontier_at = ${at}::timestamptz where user_id = ${meId}`,
      );
  }

  async function stateOf(
    number: number,
  ): Promise<{ unread: boolean; count: number }> {
    const page = await json(
      await t.app.request(`/api/projects/${slug}/issues?numbers=${number}`, {
        headers: { cookie },
      }),
    );
    expect(page.items).toHaveLength(1);
    return {
      unread: page.items[0].unread,
      count: page.items[0].unread_comments,
    };
  }

  async function bulkRead(body: unknown): Promise<Response> {
    return t.app.request("/api/me/read", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(body),
    });
  }

  it("advances a per-issue position to the microsecond", async () => {
    // The layer this endpoint exists for: an issue the caller has opened
    // carries its own issue_reads row, which outranks the frontier.
    const issue = await createIssue("has its own read position");
    await plant(issue, [US_BEFORE, US_AFTER]);
    const positioned = await t.app.request(
      `/api/projects/${slug}/issues/${issue}/read`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ up_to: EPOCH }),
      },
    );
    expect(positioned.status).toBe(204);
    expect(await stateOf(issue)).toEqual({ unread: true, count: 2 });

    expect((await bulkRead({ projects: [slug], up_to: US_CUT })).status).toBe(
      200,
    );
    // Truncating US_CUT to the millisecond would clear neither comment and
    // rounding it up would clear both; only a microsecond-exact position
    // leaves exactly the one planted 200µs later.
    expect(await stateOf(issue)).toEqual({ unread: true, count: 1 });

    // …and the position never walks back, not even by 500µs.
    expect(
      (await bulkRead({ projects: [slug], up_to: US_BEFORE })).status,
    ).toBe(200);
    expect(await stateOf(issue)).toEqual({ unread: true, count: 1 });
  });

  it("advances the frontier for issues never opened", async () => {
    const issue = await createIssue("rides the frontier");
    await plant(issue, [MS_BEFORE, MS_AFTER]);
    await backdateFrontier(EPOCH);
    expect(await stateOf(issue)).toEqual({ unread: true, count: 2 });

    expect((await bulkRead({ projects: [slug], up_to: MS_CUT })).status).toBe(
      200,
    );
    expect(await stateOf(issue)).toEqual({ unread: true, count: 1 });

    expect((await bulkRead({ projects: [slug], up_to: MS_AFTER })).status).toBe(
      200,
    );
    expect(await stateOf(issue)).toEqual({ unread: false, count: 0 });

    // Backwards stays backwards on the frontier too.
    expect((await bulkRead({ projects: [slug], up_to: EPOCH })).status).toBe(
      200,
    );
    expect(await stateOf(issue)).toEqual({ unread: false, count: 0 });
  });

  it("resolves a plain member's refs through every rung against real postgres", async () => {
    // The batched ref lookup and the batched role read only ever run on
    // PGlite otherwise: the calendar's postgres suite views as an instance
    // admin, which skips the membership query entirely.
    const before = `${slug}-old`;
    const after = `${slug}-new`;
    const foreign = `${slug}-foreign`;
    for (const name of [before, foreign]) {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug: name, name }),
      });
      expect(created.status).toBe(201);
    }
    const seated = await t.app.request(
      `/api/projects/${before}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(seated.status).toBe(204);
    const fetched = await t.app.request(`/api/projects/${before}`, {
      headers: { cookie },
    });
    expect(fetched.status).toBe(200);
    const projectId = (await json(fetched)).id as number;
    const renamed = await t.app.request(`/api/projects/${before}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ slug: after }),
    });
    expect(renamed.status).toBe(200);

    // Mint bob's read frontier before the card exists. It is created lazily on
    // his first read, so a card planted first is dated before his epoch and
    // arrives already read — the warm-up test/inbox-placements.test.ts spells
    // out for the same reason.
    const warmed = await t.app.request("/api/me/inbox", {
      headers: bob.headers,
    });
    expect(warmed.status).toBe(200);

    const issue = await t.app.request(`/api/projects/${after}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "swept through three rungs" }),
    });
    expect(issue.status).toBe(201);
    const number = (await json(issue)).number as number;
    const posted = await t.app.request(
      `/api/projects/${after}/issues/${number}/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: "from someone else" }),
      },
    );
    expect(posted.status).toBe(201);

    const unreadFor = async (who: Record<string, string>) => {
      const page = await json(
        await t.app.request(`/api/projects/${after}/issues?numbers=${number}`, {
          headers: who,
        }),
      );
      expect(page.items).toHaveLength(1);
      return page.items[0].unread as boolean;
    };
    expect(await unreadFor(bob.headers)).toBe(true);

    const asBob = (body: unknown) =>
      t.app.request("/api/me/read", {
        method: "PUT",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify(body),
      });
    expect(
      (await asBob({ projects: [after, String(projectId), before] })).status,
    ).toBe(200);
    expect(await unreadFor(bob.headers)).toBe(false);

    const refused = await asBob({ projects: [after, foreign] });
    expect(refused.status).toBe(404);
    expect((await json(refused)).error.message).toBe(PROJECT_NOT_FOUND);
  });

  it("reads just a selection, and keeps a position already ahead (T-775)", async () => {
    // Three kinds of row in one multi-row upsert: an existing issue_reads
    // row, a card riding the frontier with no row yet, and a row whose
    // position is ahead of now() down to the microsecond.
    const opened = await createIssue("selected, has a position");
    const fresh = await createIssue("selected, rides the frontier");
    const ahead = await createIssue("selected, read into the future");
    const left = await createIssue("not selected");
    for (const n of [opened, fresh, ahead, left]) {
      await plant(n, [MS_BEFORE, MS_AFTER]);
    }
    for (const n of [opened, ahead]) {
      const positioned = await t.app.request(
        `/api/projects/${slug}/issues/${n}/read`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ up_to: EPOCH }),
        },
      );
      expect(positioned.status).toBe(204);
    }
    const FUTURE = "2099-01-01 00:00:00.000123+00";
    const db = t.ctx.router.system();
    await db.execute(
      sql`update issue_reads set last_seen_at = ${FUTURE}::timestamptz
          where user_id = ${meId} and issue_id = (
            select id from issues where number = ${ahead}
              and project_id = (select id from projects where slug = ${slug}))`,
    );
    await backdateFrontier(EPOCH);
    for (const n of [opened, fresh, left]) {
      expect(await stateOf(n)).toEqual({ unread: true, count: 2 });
    }

    const res = await t.app.request(`/api/projects/${slug}/issues/read`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ numbers: [opened, fresh, ahead, 999_999] }),
    });
    expect(res.status).toBe(204);
    for (const n of [opened, fresh, ahead]) {
      expect(await stateOf(n)).toEqual({ unread: false, count: 0 });
    }
    expect(await stateOf(left)).toEqual({ unread: true, count: 2 });

    // `greatest` against the stored value, not the batch's now(): the later
    // position survives to the microsecond.
    const kept = await db.execute(
      sql`select to_char(last_seen_at at time zone 'UTC',
                         'YYYY-MM-DD HH24:MI:SS.US') as at
          from issue_reads
          where user_id = ${meId} and issue_id = (
            select id from issues where number = ${ahead}
              and project_id = (select id from projects where slug = ${slug}))`,
    );
    const rows = Array.isArray(kept)
      ? kept
      : (kept as unknown as { rows: Record<string, unknown>[] }).rows;
    expect(rows.map((r) => r.at)).toEqual(["2099-01-01 00:00:00.000123"]);
  });

  it("clears a default sweep dated by the project database's own clock", async () => {
    const opened = await createIssue("opened, then swept");
    const untouched = await createIssue("never opened, then swept");
    await plant(opened, [MS_BEFORE, MS_AFTER]);
    await plant(untouched, [MS_BEFORE, MS_AFTER]);
    const positioned = await t.app.request(
      `/api/projects/${slug}/issues/${opened}/read`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ up_to: EPOCH }),
      },
    );
    expect(positioned.status).toBe(204);
    await backdateFrontier(EPOCH);
    expect(await stateOf(opened)).toEqual({ unread: true, count: 2 });
    expect(await stateOf(untouched)).toEqual({ unread: true, count: 2 });

    // No up_to: postgres dates the sweep itself, and both layers land after
    // everything planted.
    expect((await bulkRead({ projects: [slug] })).status).toBe(200);
    expect(await stateOf(opened)).toEqual({ unread: false, count: 0 });
    expect(await stateOf(untouched)).toEqual({ unread: false, count: 0 });
  });

  describe("undo (T-814)", () => {
    const issueOf = (number: number) =>
      sql`(select id from issues where number = ${number}
             and project_id = (select id from projects where slug = ${slug}))`;

    async function text(query: ReturnType<typeof sql>): Promise<string> {
      const got = await t.ctx.router.system().execute(query);
      const rows = Array.isArray(got)
        ? got
        : (got as unknown as { rows: Record<string, unknown>[] }).rows;
      expect(rows).toHaveLength(1);
      return rows[0]?.at as string;
    }

    const positionOf = (number: number) =>
      text(
        sql`select to_char(last_seen_at at time zone 'UTC',
                           'YYYY-MM-DD HH24:MI:SS.US') as at
            from issue_reads
            where user_id = ${meId} and issue_id = ${issueOf(number)}`,
      );

    const frontierOf = () =>
      text(
        sql`select to_char(frontier_at at time zone 'UTC',
                           'YYYY-MM-DD HH24:MI:SS.US') as at
            from read_frontiers
            where user_id = ${meId}
              and project_id = (select id from projects where slug = ${slug})`,
      );

    /** A card read up to US_CUT: one of its two planted comments unread. */
    async function readToCut(title: string): Promise<number> {
      const issue = await createIssue(title);
      await plant(issue, [US_BEFORE, US_AFTER]);
      // The single-issue endpoint would round US_CUT to the millisecond.
      const positioned = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/read`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ up_to: EPOCH }),
        },
      );
      expect(positioned.status).toBe(204);
      await t.ctx.router.system().execute(
        sql`update issue_reads set last_seen_at = ${US_CUT}::timestamptz
              where user_id = ${meId} and issue_id = ${issueOf(issue)}`,
      );
      expect(await stateOf(issue)).toEqual({ unread: true, count: 1 });
      return issue;
    }

    async function sweep(upTo: string): Promise<string> {
      const res = await bulkRead({ projects: [slug], up_to: upTo });
      expect(res.status).toBe(200);
      return (await json(res)).undo;
    }

    async function undo(token: string): Promise<void> {
      const res = await t.app.request("/api/me/read/undo", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ undo: token }),
      });
      expect(res.status).toBe(204);
    }

    it("puts both layers back to the microsecond", async () => {
      const opened = await readToCut("swept, then undone");
      const fresh = await createIssue("never opened, swept, then undone");
      await plant(fresh, [MS_BEFORE, MS_AFTER]);
      await backdateFrontier(MS_CUT);
      expect(await stateOf(fresh)).toEqual({ unread: true, count: 1 });

      const token = await sweep("2026-03-03T10:00:03.000123Z");
      expect(await stateOf(opened)).toEqual({ unread: false, count: 0 });
      expect(await stateOf(fresh)).toEqual({ unread: false, count: 0 });

      await undo(token);
      expect(await positionOf(opened)).toBe("2026-03-03 10:00:01.000500");
      expect(await frontierOf()).toBe("2026-03-03 10:00:02.200000");
      expect(await stateOf(opened)).toEqual({ unread: true, count: 1 });
      expect(await stateOf(fresh)).toEqual({ unread: true, count: 1 });
    });

    it("keeps a card read a microsecond before the sweep's position", async () => {
      const issue = await readToCut("read again just behind the sweep");
      const at = "2026-03-03T10:00:04.000123Z";
      const token = await sweep(at);

      // An `up_to` behind the sweep leaves the position where the sweep put
      // it, which is exactly what the undo looks for.
      const reread = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/read`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ up_to: "2026-03-03T10:00:04.000122Z" }),
        },
      );
      expect(reread.status).toBe(204);
      expect(await positionOf(issue)).toBe("2026-03-03 10:00:04.000123");

      await undo(token);
      expect(await positionOf(issue)).toBe("2026-03-03 10:00:04.000123");
      expect(await stateOf(issue)).toEqual({ unread: false, count: 0 });
    });
  });
});
