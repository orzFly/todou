import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProjectByRef, routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps in the DB carry µs; keep actions >1ms apart so read
 *  positions minted with ms-precision now() can never tie with them. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe.each(PLACEMENTS)("bulk mark-as-read T-100 (%s)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const suffix = placement.replaceAll(/[^a-z]/g, "");
  const PA = `bulk-a-${suffix}`;
  const PB = `bulk-b-${suffix}`;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    bob = await addUserWithToken(t.ctx, `bob-${suffix}`);
    for (const slug of [PA, PB]) {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(created.status).toBe(201);
      const member = await t.app.request(
        `/api/projects/${slug}/members/${bob.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);
      // Bootstrap the caller's frontier before any activity exists, or the
      // first list call would date it after bob's comments and nothing
      // would ever read as unread (T-35).
      await createIssue(slug, "frontier bootstrap");
      const listed = await t.app.request(`/api/projects/${slug}/issues`, {
        headers: { cookie },
      });
      expect(listed.status).toBe(200);
    }
    await settle();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  async function createIssue(slug: string, title: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  async function comment(
    slug: string,
    number: number,
    body: string,
  ): Promise<void> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(201);
  }

  /** unread flag + foreign-comment count as the cookie user sees them. */
  async function stateOf(
    slug: string,
    number: number,
    who: Record<string, string> = { cookie },
  ): Promise<{ unread: boolean; count: number }> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues?numbers=${number}`,
      { headers: who },
    );
    expect(res.status).toBe(200);
    const page = await json(res);
    expect(page.items).toHaveLength(1);
    return {
      unread: page.items[0].unread,
      count: page.items[0].unread_comments,
    };
  }

  async function markIssueRead(slug: string, number: number): Promise<void> {
    await settle();
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/read`,
      { method: "PUT", headers: headers(), body: "{}" },
    );
    expect(res.status).toBe(204);
  }

  async function bulkRead(
    body: unknown = {},
    who: Record<string, string> = { cookie },
  ): Promise<Response> {
    await settle();
    return t.app.request("/api/me/read", {
      method: "PUT",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify(body),
    });
  }

  it("clears issues the frontier alone would leave behind", async () => {
    // The trap this card exists for: an issue the caller has opened owns a
    // per-issue position that outranks the frontier, so a sweep that only
    // moved the frontier would leave this one lit.
    const opened = await createIssue(PA, "already has a read position");
    await comment(PA, opened, "first word");
    await markIssueRead(PA, opened);
    await settle();
    await comment(PA, opened, "second word");
    expect(await stateOf(PA, opened)).toEqual({ unread: true, count: 1 });

    // …next to one that never got a position and rides on the frontier.
    const fresh = await createIssue(PA, "never opened");
    await comment(PA, fresh, "hello");
    expect(await stateOf(PA, fresh)).toEqual({ unread: true, count: 1 });

    expect((await bulkRead({ projects: [PA] })).status).toBe(200);
    expect(await stateOf(PA, opened)).toEqual({ unread: false, count: 0 });
    expect(await stateOf(PA, fresh)).toEqual({ unread: false, count: 0 });
  });

  it("stops at the named project", async () => {
    const here = await createIssue(PA, "in scope");
    const elsewhere = await createIssue(PB, "out of scope");
    await comment(PA, here, "noise");
    await comment(PB, elsewhere, "noise");
    expect((await stateOf(PA, here)).unread).toBe(true);
    expect((await stateOf(PB, elsewhere)).unread).toBe(true);

    expect((await bulkRead({ projects: [PA] })).status).toBe(200);
    expect((await stateOf(PA, here)).unread).toBe(false);
    // Under shared placement both projects sit in one database and one
    // issue_reads table — the sweep must still respect the project column.
    expect((await stateOf(PB, elsewhere)).unread).toBe(true);
  });

  it("sweeps every readable project when the scope is omitted", async () => {
    const a = await createIssue(PA, "everywhere a");
    const b = await createIssue(PB, "everywhere b");
    await comment(PA, a, "noise");
    await comment(PB, b, "noise");
    expect((await stateOf(PA, a)).unread).toBe(true);
    expect((await stateOf(PB, b)).unread).toBe(true);

    expect((await bulkRead()).status).toBe(200);
    expect((await stateOf(PA, a)).unread).toBe(false);
    expect((await stateOf(PB, b)).unread).toBe(false);
  });

  it("advances to an explicit up_to and never regresses", async () => {
    const issue = await createIssue(PA, "boundary");
    await comment(PA, issue, "before the line");
    await settle();
    const line = new Date().toISOString();
    await settle();
    await comment(PA, issue, "after the line");
    expect(await stateOf(PA, issue)).toEqual({ unread: true, count: 2 });

    expect((await bulkRead({ projects: [PA], up_to: line })).status).toBe(200);
    expect(await stateOf(PA, issue)).toEqual({ unread: true, count: 1 });

    expect((await bulkRead({ projects: [PA] })).status).toBe(200);
    expect(await stateOf(PA, issue)).toEqual({ unread: false, count: 0 });

    // A late request carrying an ancient position must not re-light it.
    const regress = await bulkRead({
      projects: [PA],
      up_to: "2000-01-01T00:00:00Z",
    });
    expect(regress.status).toBe(200);
    expect(await stateOf(PA, issue)).toEqual({ unread: false, count: 0 });
  });

  async function readSome(
    slug: string,
    numbers: number[],
    who: Record<string, string> = { cookie },
  ): Promise<Response> {
    await settle();
    return t.app.request(`/api/projects/${slug}/issues/read`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify({ numbers }),
    });
  }

  it("marks just the named cards read (T-775)", async () => {
    const picked = [
      await createIssue(PA, "picked one"),
      await createIssue(PA, "picked two"),
      await createIssue(PA, "picked three"),
    ];
    const left = await createIssue(PA, "not picked");
    for (const n of [...picked, left]) await comment(PA, n, "noise");
    for (const n of [...picked, left]) {
      expect((await stateOf(PA, n)).unread).toBe(true);
    }

    expect((await readSome(PA, picked)).status).toBe(204);
    for (const n of picked) {
      expect(await stateOf(PA, n)).toEqual({ unread: false, count: 0 });
    }
    expect((await stateOf(PA, left)).unread).toBe(true);
  });

  it("skips numbers naming nothing live, and reads the rest", async () => {
    const kept = await createIssue(PA, "kept");
    const trashed = await createIssue(PA, "trashed");
    await comment(PA, kept, "noise");
    const del = await t.app.request(`/api/projects/${PA}/issues/${trashed}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(204);

    expect((await readSome(PA, [kept, trashed, 99_999])).status).toBe(204);
    expect((await stateOf(PA, kept)).unread).toBe(false);
  });

  it("does not pull back a position set further ahead", async () => {
    const issue = await createIssue(PA, "read into the future");
    await settle();
    const ahead = await t.app.request(
      `/api/projects/${PA}/issues/${issue}/read`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({
          up_to: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      },
    );
    expect(ahead.status).toBe(204);
    expect((await readSome(PA, [issue])).status).toBe(204);
    await settle();
    // Still ahead of this comment only if the bulk call kept the later mark.
    await comment(PA, issue, "lands before the future position");
    expect((await stateOf(PA, issue)).unread).toBe(false);
  });

  it("is open to readers", async () => {
    const reader = await addUserWithToken(t.ctx, `reader-${suffix}`);
    const member = await t.app.request(
      `/api/projects/${PA}/members/${reader.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(member.status).toBe(204);
    const issue = await createIssue(PA, "for the reader");
    expect((await readSome(PA, [issue], reader.headers)).status).toBe(204);
  });

  it("never invents unread history for a newcomer", async () => {
    const issue = await createIssue(PA, "history the newcomer missed");
    await comment(PA, issue, "said before they arrived");
    const carol = await addUserWithToken(t.ctx, `carol-${suffix}`);
    const member = await t.app.request(
      `/api/projects/${PA}/members/${carol.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(member.status).toBe(204);

    // Carol has no frontier yet. Seeding one from this ancient up_to would
    // turn a mark-read call into a source of unread history.
    const swept = await bulkRead(
      { up_to: "2000-01-01T00:00:00Z" },
      carol.headers,
    );
    expect(swept.status).toBe(200);
    expect(await stateOf(PA, issue, carol.headers)).toEqual({
      unread: false,
      count: 0,
    });
  });

  it("leaves no trace on the timeline", async () => {
    const issue = await createIssue(PA, "quiet sweep");
    await comment(PA, issue, "noise");
    const before = await json(
      await t.app.request(`/api/projects/${PA}/issues/${issue}/timeline`, {
        headers: { cookie },
      }),
    );

    expect((await bulkRead({ projects: [PA] })).status).toBe(200);
    const after = await json(
      await t.app.request(`/api/projects/${PA}/issues/${issue}/timeline`, {
        headers: { cookie },
      }),
    );
    expect(after.items).toHaveLength(before.items.length);
  });

  it("404s projects I cannot read and 422s a malformed body", async () => {
    expect((await bulkRead({ projects: ["no-such-project"] })).status).toBe(
      404,
    );
    // Bob is not a member of a third project, so it must not even exist to
    // him — same 404 the per-project endpoints give.
    const secret = `bulk-secret-${suffix}`;
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: secret, name: secret }),
    });
    expect(created.status).toBe(201);
    expect((await bulkRead({ projects: [secret] }, bob.headers)).status).toBe(
      404,
    );

    expect((await bulkRead({ up_to: "yesterday" })).status).toBe(422);
    expect((await bulkRead({ project: [PA] })).status).toBe(422);
    expect((await bulkRead({ projects: "not-an-array" })).status).toBe(422);
  });

  it("sweeps a project named by a slug it has since retired", async () => {
    const before = `bulk-old-${suffix}`;
    const after = `bulk-new-${suffix}`;
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: before, name: before }),
    });
    expect(created.status).toBe(201);
    const seated = await t.app.request(
      `/api/projects/${before}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(seated.status).toBe(204);
    // Same bootstrap the shared projects get in beforeAll: without a
    // frontier minted before any activity, nothing here reads as unread.
    await createIssue(before, "frontier bootstrap");
    expect(
      (
        await t.app.request(`/api/projects/${before}/issues`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    await settle();
    const issue = await createIssue(before, "named by a retired slug");
    const renamed = await t.app.request(`/api/projects/${before}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ slug: after }),
    });
    expect(renamed.status).toBe(200);
    await comment(after, issue, "noise");
    expect((await stateOf(after, issue)).unread).toBe(true);

    expect((await bulkRead({ projects: [before] })).status).toBe(200);
    expect((await stateOf(after, issue)).unread).toBe(false);
  });

  it("accepts an empty scope as a no-op", async () => {
    const issue = await createIssue(PA, "untouched by an empty sweep");
    await comment(PA, issue, "noise");
    expect((await bulkRead({ projects: [] })).status).toBe(200);
    expect((await stateOf(PA, issue)).unread).toBe(true);
  });

  it("regression watchdog: accepts one project named twice", async () => {
    // `ProjectSlug` allows an all-digit ref (only `ProjectSlugInput` forbids
    // one), and `findProjectByRef` answers that ref from the id branch — so
    // these two strings are one project, as a retired slug beside its
    // current one would also be. A multi-row upsert may not name the same
    // conflict key twice, so the sweep has to deduplicate by project id.
    //
    // A regression watchdog, not a claim: one statement per project could
    // not hit that conflict, so this was green before the rollup landed.
    const issue = await createIssue(PA, "named by slug and by id");
    await comment(PA, issue, "noise");
    const meta = await json(
      await t.app.request(`/api/projects/${PA}`, { headers: { cookie } }),
    );
    expect((await bulkRead({ projects: [PA, String(meta.id)] })).status).toBe(
      200,
    );
    expect((await stateOf(PA, issue)).unread).toBe(false);
  });

  it("regression watchdog: keeps an up_to's microseconds", async () => {
    // Green before this card too: it guards `at` staying a string with an
    // explicit cast through the rollup, since a JS Date bound here would
    // round the position to milliseconds and only the postgres-only suite
    // watched that before.
    //
    // Its own project: this sweep parks a frontier in 2027, and `greatest`
    // would keep it there for every later expectation of an unread card.
    const slug = `bulk-us-${suffix}`;
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(created.status).toBe(201);
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );

    expect(
      (
        await bulkRead({
          projects: [slug],
          up_to: "2027-04-04T10:00:00.123456Z",
        })
      ).status,
    ).toBe(200);

    // Read back as text: drizzle hands a timestamp column to JS as a Date,
    // which is where the microseconds would disappear even if the database
    // still held them. Pinned to UTC because a bare timestamptz::text renders
    // in the session's TimeZone, which PGlite takes from the host.
    const row = await getProjectByRef(t.ctx, slug);
    const db = await t.ctx.router.forProject(routeInfoOf(row));
    const got = await db.execute(
      sql`select (frontier_at at time zone 'UTC')::text as t from read_frontiers
          where project_id = ${row.id} and user_id = ${me.id}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: driver-agnostic result shape
    const rows = (got as any).rows ?? got;
    expect(rows).toHaveLength(1);
    expect(rows[0].t).toBe("2027-04-04 10:00:00.123456");
  });

  describe("undo (T-814)", () => {
    async function sweep(
      body: unknown = { projects: [PA] },
      who: Record<string, string> = { cookie },
    ): Promise<string> {
      const res = await bulkRead(body, who);
      expect(res.status).toBe(200);
      const { undo } = await json(res);
      expect(typeof undo).toBe("string");
      return undo;
    }

    async function undo(
      token: unknown,
      who: Record<string, string> = { cookie },
    ): Promise<Response> {
      await settle();
      return t.app.request("/api/me/read/undo", {
        method: "POST",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify({ undo: token }),
      });
    }

    /** A card the cookie user has opened, so it owns a read position. */
    async function openedCard(slug: string, title: string): Promise<number> {
      const number = await createIssue(slug, title);
      await markIssueRead(slug, number);
      await settle();
      return number;
    }

    async function bobCreates(slug: string, title: string): Promise<number> {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      return (await json(res)).number;
    }

    async function createProject(slug: string): Promise<void> {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(created.status).toBe(201);
      const member = await t.app.request(
        `/api/projects/${slug}/members/${bob.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);
    }

    /** Bob's frontier in `slug`, read back as microsecond text. */
    async function bobFrontier(slug: string): Promise<string> {
      const row = await getProjectByRef(t.ctx, slug);
      const db = await t.ctx.router.forProject(routeInfoOf(row));
      const got = await db.execute(
        sql`select (frontier_at at time zone 'UTC')::text as t
            from read_frontiers
            where project_id = ${row.id} and user_id = ${bob.user.id}`,
      );
      // biome-ignore lint/suspicious/noExplicitAny: driver-agnostic result shape
      const rows = (got as any).rows ?? got;
      expect(rows).toHaveLength(1);
      return rows[0].t;
    }

    it("puts back every kind of unread the sweep cleared", async () => {
      const commented = await openedCard(PA, "two comments waiting");
      await comment(PA, commented, "one");
      await comment(PA, commented, "two");

      // Weak unread: an action, nothing to count.
      const moved = await openedCard(PA, "status moved");
      const statuses = await json(
        await t.app.request(`/api/projects/${PA}/statuses`, {
          headers: { cookie },
        }),
      );
      const other = statuses.find((s: { name: string }) => s.name !== "Todo");
      const patched = await t.app.request(
        `/api/projects/${PA}/issues/${moved}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ status_id: other.id }),
        },
      );
      expect(patched.status).toBe(200);

      // An edit that adds a mention makes no comment and no event: only the
      // mention can light this card.
      const me = await json(
        await t.app.request("/api/me", { headers: { cookie } }),
      );
      const named = await createIssue(PA, "mentioned by an edit");
      const posted = await t.app.request(
        `/api/projects/${PA}/issues/${named}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ body: "plain" }),
        },
      );
      expect(posted.status).toBe(201);
      const { id: commentId } = await json(posted);
      await markIssueRead(PA, named);
      await settle();
      const edited = await t.app.request(
        `/api/projects/${PA}/issues/${named}/comments/${commentId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ body: `plain, @${me.login}` }),
        },
      );
      expect(edited.status).toBe(200);

      // Never opened: only the frontier decides this one.
      const fresh = await bobCreates(PA, "never opened");

      const cards = { commented, moved, named, fresh };
      const states = async () => {
        const out: Record<string, { unread: boolean; count: number }> = {};
        for (const [name, n] of Object.entries(cards)) {
          out[name] = await stateOf(PA, n);
        }
        return out;
      };
      const before = {
        commented: { unread: true, count: 2 },
        moved: { unread: true, count: 0 },
        named: { unread: true, count: 0 },
        fresh: { unread: true, count: 1 },
      };
      expect(await states()).toEqual(before);

      const token = await sweep();
      for (const n of Object.values(cards)) {
        expect(await stateOf(PA, n)).toEqual({ unread: false, count: 0 });
      }

      expect((await undo(token)).status).toBe(204);
      expect(await states()).toEqual(before);
    });

    it("leaves a card read since the sweep read", async () => {
      const opened = await openedCard(PA, "opened after the sweep");
      const picked = await openedCard(PA, "multi-selected after the sweep");
      const pickedFresh = await bobCreates(PA, "never opened, then picked");
      const viaCli = await openedCard(PA, "read by the CLI after the sweep");
      for (const n of [opened, picked, viaCli]) await comment(PA, n, "news");
      await settle();
      // What `todou issue view` sends: the newest item it showed, which
      // predates the sweep's `at`.
      const shown = new Date().toISOString();
      const untouched = await openedCard(PA, "nobody read this one");
      await comment(PA, untouched, "news");

      const token = await sweep();
      await markIssueRead(PA, opened);
      expect((await readSome(PA, [picked, pickedFresh])).status).toBe(204);
      const cli = await t.app.request(
        `/api/projects/${PA}/issues/${viaCli}/read`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ up_to: shown }),
        },
      );
      expect(cli.status).toBe(204);

      expect((await undo(token)).status).toBe(204);
      for (const n of [opened, picked, pickedFresh, viaCli]) {
        expect(await stateOf(PA, n)).toEqual({ unread: false, count: 0 });
      }
      expect(await stateOf(PA, untouched)).toEqual({ unread: true, count: 1 });
    });

    it("steps back only one sweep of a project swept twice", async () => {
      const opened = await openedCard(PA, "swept twice");
      await comment(PA, opened, "before the first sweep");
      const fresh = await bobCreates(PA, "never opened, swept twice");
      const first = await sweep();

      await comment(PA, opened, "between the sweeps");
      await comment(PA, fresh, "between the sweeps");
      const states = async () => ({
        opened: await stateOf(PA, opened),
        fresh: await stateOf(PA, fresh),
      });
      const afterFirst = {
        opened: { unread: true, count: 1 },
        fresh: { unread: true, count: 1 },
      };
      const read = {
        opened: { unread: false, count: 0 },
        fresh: { unread: false, count: 0 },
      };
      expect(await states()).toEqual(afterFirst);
      // The project header's sweep, then the inbox's.
      const second = await sweep({});

      // The second sweep owns these positions now.
      expect((await undo(first)).status).toBe(204);
      expect(await states()).toEqual(read);

      expect((await undo(second)).status).toBe(204);
      expect(await states()).toEqual(afterFirst);

      // Undoing the second cleared what the first had stored.
      expect((await undo(first)).status).toBe(204);
      expect(await states()).toEqual(afterFirst);
    });

    it("undoes one project's sweep without touching another's", async () => {
      const here = await openedCard(PA, "undone here");
      const there = await openedCard(PB, "stays read there");
      await comment(PA, here, "news");
      await comment(PB, there, "news");
      const token = await sweep({ projects: [PA] });
      await sweep({ projects: [PB] });

      expect((await undo(token)).status).toBe(204);
      expect(await stateOf(PA, here)).toEqual({ unread: true, count: 1 });
      // Under shared placement one table holds both projects' rows.
      expect(await stateOf(PB, there)).toEqual({ unread: false, count: 0 });
    });

    it("skips a project the caller can no longer read", async () => {
      const gone = `bulk-gone-${suffix}`;
      await createProject(gone);
      // Bob's frontiers in both projects predate the card below.
      for (const slug of [PA, gone]) {
        const listed = await t.app.request(`/api/projects/${slug}/issues`, {
          headers: bob.headers,
        });
        expect(listed.status).toBe(200);
      }
      await settle();
      const issue = await createIssue(PA, "unread for bob");
      const bobState = () => stateOf(PA, issue, bob.headers);
      expect(await bobState()).toEqual({ unread: true, count: 1 });

      const token = await sweep({ projects: [PA, gone] }, bob.headers);
      expect(await bobState()).toEqual({ unread: false, count: 0 });
      const swept = await bobFrontier(gone);
      const removed = await t.app.request(
        `/api/projects/${gone}/members/${bob.user.id}`,
        { method: "DELETE", headers: { cookie } },
      );
      expect(removed.status).toBe(204);

      expect((await undo(token, bob.headers)).status).toBe(204);
      expect(await bobState()).toEqual({ unread: true, count: 1 });
      expect(await bobFrontier(gone)).toBe(swept);
    });

    it("422s a malformed token", async () => {
      const b64 = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      for (const token of ["!!!", b64([]), b64({ v: 2, at: [] })]) {
        expect((await undo(token)).status, token).toBe(422);
      }
    });

    it("keeps a frontier the sweep created", async () => {
      // Bob has never looked at this project, so the sweep is what makes his
      // frontier here; the card before it is history he never saw.
      const unseen = `bulk-unseen-${suffix}`;
      await createProject(unseen);
      const issue = await createIssue(unseen, "history bob never saw");

      const token = await sweep({ projects: [unseen] }, bob.headers);
      const created = await bobFrontier(unseen);
      expect((await undo(token, bob.headers)).status).toBe(204);
      expect(await bobFrontier(unseen)).toBe(created);
      expect(await stateOf(unseen, issue, bob.headers)).toEqual({
        unread: false,
        count: 0,
      });
    });
  });
});
