import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

    expect((await bulkRead({ projects: [PA] })).status).toBe(204);
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

    expect((await bulkRead({ projects: [PA] })).status).toBe(204);
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

    expect((await bulkRead()).status).toBe(204);
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

    expect((await bulkRead({ projects: [PA], up_to: line })).status).toBe(204);
    expect(await stateOf(PA, issue)).toEqual({ unread: true, count: 1 });

    expect((await bulkRead({ projects: [PA] })).status).toBe(204);
    expect(await stateOf(PA, issue)).toEqual({ unread: false, count: 0 });

    // A late request carrying an ancient position must not re-light it.
    const regress = await bulkRead({
      projects: [PA],
      up_to: "2000-01-01T00:00:00Z",
    });
    expect(regress.status).toBe(204);
    expect(await stateOf(PA, issue)).toEqual({ unread: false, count: 0 });
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
    expect(swept.status).toBe(204);
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

    expect((await bulkRead({ projects: [PA] })).status).toBe(204);
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

  it("accepts an empty scope as a no-op", async () => {
    const issue = await createIssue(PA, "untouched by an empty sweep");
    await comment(PA, issue, "noise");
    expect((await bulkRead({ projects: [] })).status).toBe(204);
    expect((await stateOf(PA, issue)).unread).toBe(true);
  });
});
