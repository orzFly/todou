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
      204,
    );
    // Truncating US_CUT to the millisecond would clear neither comment and
    // rounding it up would clear both; only a microsecond-exact position
    // leaves exactly the one planted 200µs later.
    expect(await stateOf(issue)).toEqual({ unread: true, count: 1 });

    // …and the position never walks back, not even by 500µs.
    expect(
      (await bulkRead({ projects: [slug], up_to: US_BEFORE })).status,
    ).toBe(204);
    expect(await stateOf(issue)).toEqual({ unread: true, count: 1 });
  });

  it("advances the frontier for issues never opened", async () => {
    const issue = await createIssue("rides the frontier");
    await plant(issue, [MS_BEFORE, MS_AFTER]);
    await backdateFrontier(EPOCH);
    expect(await stateOf(issue)).toEqual({ unread: true, count: 2 });

    expect((await bulkRead({ projects: [slug], up_to: MS_CUT })).status).toBe(
      204,
    );
    expect(await stateOf(issue)).toEqual({ unread: true, count: 1 });

    expect((await bulkRead({ projects: [slug], up_to: MS_AFTER })).status).toBe(
      204,
    );
    expect(await stateOf(issue)).toEqual({ unread: false, count: 0 });

    // Backwards stays backwards on the frontier too.
    expect((await bulkRead({ projects: [slug], up_to: EPOCH })).status).toBe(
      204,
    );
    expect(await stateOf(issue)).toEqual({ unread: false, count: 0 });
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
    expect((await bulkRead({ projects: [slug] })).status).toBe(204);
    expect(await stateOf(opened)).toEqual({ unread: false, count: 0 });
    expect(await stateOf(untouched)).toEqual({ unread: false, count: 0 });
  });
});
