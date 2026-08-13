import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps in the DB carry µs; keep actions >1ms apart so read
 *  positions minted with ms-precision now() can never tie with them. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const PA = "inbox-a";
const PB = "inbox-b";

describe("cross-project inbox T-97", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  const inbox = async (
    qs = "",
    who?: Record<string, string>,
  ): Promise<Response> =>
    t.app.request(`/api/me/inbox${qs}`, { headers: who ?? { cookie } });

  const items = async (qs = "", who?: Record<string, string>) => {
    const res = await inbox(qs, who);
    expect(res.status).toBe(200);
    return json(res);
  };

  const rowOf = (
    page: { items: { number: number; project: { slug: string } }[] },
    slug: string,
    number: number,
  ) =>
    page.items.find(
      (i: { number: number; project: { slug: string } }) =>
        i.project.slug === slug && i.number === number,
    );

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
    who: Record<string, string>,
    body: string,
    component?: unknown,
  ): Promise<Response> {
    return t.app.request(`/api/projects/${slug}/issues/${number}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify(component ? { body, component } : { body }),
    });
  }

  async function markRead(slug: string, number: number): Promise<void> {
    await settle();
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/read`,
      { method: "PUT", headers: headers(), body: "{}" },
    );
    expect(res.status).toBe(204);
  }

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const [slug, name] of [
      [PA, "Inbox A"],
      [PB, "Inbox B"],
    ] as const) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name }),
      });
      expect(res.status).toBe(201);
    }
    bob = await addUserWithToken(t.ctx, "inbox-bob");
    for (const slug of [PA, PB]) {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${bob.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(res.status).toBe(204);
    }
    // First call mints both frontiers: history up to here never counts.
    const page = await items();
    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(false);
    await settle();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("collects foreign comments across projects, sorted by recency", async () => {
    const a1 = await createIssue(PA, "strong unread in A");
    const b1 = await createIssue(PB, "strong unread in B");
    await comment(PA, a1, bob.headers, "first");
    await settle();
    await comment(PB, b1, bob.headers, "second");

    const page = await items();
    const rowA = rowOf(page, PA, a1);
    const rowB = rowOf(page, PB, b1);
    expect(rowA).toMatchObject({
      unread: true,
      unread_comments: 1,
      pending_spec_review: false,
      project: { slug: PA, name: "Inbox A" },
    });
    expect(rowB).toMatchObject({ unread: true, unread_comments: 1 });
    // B's comment is newer, so B sorts first.
    expect(page.items.indexOf(rowB)).toBeLessThan(page.items.indexOf(rowA));

    await markRead(PA, a1);
    await markRead(PB, b1);
  });

  it("my own activity never lands in my inbox", async () => {
    const n = await createIssue(PA, "talking to myself");
    await comment(PA, n, headers(), "note to self");
    expect(rowOf(await items(), PA, n)).toBeUndefined();
  });

  it("event-only activity shows as weak unread; the toggle hides it", async () => {
    const n = await createIssue(PA, "weak unread");
    await settle();
    const res = await t.app.request(`/api/projects/${PA}/issues/${n}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob.headers },
      body: JSON.stringify({ title: "weak unread (retitled)" }),
    });
    expect(res.status).toBe(200);

    const row = rowOf(await items(), PA, n);
    expect(row).toMatchObject({ unread: true, unread_comments: 0 });

    const off = await t.app.request("/api/me/prefs", {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ show_weak_unread: false }),
    });
    expect(off.status).toBe(200);
    expect(rowOf(await items(), PA, n)).toBeUndefined();

    // Strong unread survives the toggle.
    const strong = await createIssue(PA, "still strong");
    await comment(PA, strong, bob.headers, "loud");
    expect(rowOf(await items(), PA, strong)).toBeDefined();

    const on = await t.app.request("/api/me/prefs", {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ show_weak_unread: true }),
    });
    expect(on.status).toBe(200);
    expect(rowOf(await items(), PA, n)).toBeDefined();

    await markRead(PA, n);
    await markRead(PA, strong);
  });

  it("per-issue read position beats the frontier", async () => {
    const n = await createIssue(PB, "read then poked again");
    await comment(PB, n, bob.headers, "one");
    await markRead(PB, n);
    expect(rowOf(await items(), PB, n)).toBeUndefined();

    await comment(PB, n, bob.headers, "two");
    const row = rowOf(await items(), PB, n);
    expect(row).toMatchObject({ unread: true, unread_comments: 1 });
    await markRead(PB, n);
  });

  it("closed issues with unread activity still show", async () => {
    const n = await createIssue(PA, "closed but unread");
    await comment(PA, n, bob.headers, "closing note");
    const statuses = await json(
      await t.app.request(`/api/projects/${PA}/statuses`, {
        headers: { cookie },
      }),
    );
    const done = statuses.find(
      (s: { category: string }) => s.category === "closed",
    );
    const res = await t.app.request(`/api/projects/${PA}/issues/${n}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status_id: done.id }),
    });
    expect(res.status).toBe(200);

    const row = rowOf(await items(), PA, n);
    expect(row).toMatchObject({ unread: true, status: { category: "closed" } });
    await markRead(PA, n);
  });

  it("specs pushed by others await my review; my own never do", async () => {
    const n = await createIssue(PA, "spec by bob");
    const push = await t.app.request(
      `/api/projects/${PA}/issues/${n}/spec/push`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify({
          files: [{ path: "design.md", body: "# v1" }],
          message: "v1",
        }),
      },
    );
    expect(push.status).toBe(200);

    let row = rowOf(await items(), PA, n);
    expect(row).toMatchObject({ pending_spec_review: true });

    // Bob pushed it, so bob's own inbox must not call it pending — and
    // with nothing else foreign to bob on this issue, it's absent.
    const bobPage = await items("", bob.headers);
    expect(rowOf(bobPage, PA, n)).toBeUndefined();

    // A verdict clears the pending state (approve; the review event is
    // mine, so no new unread either).
    const review = await t.app.request(
      `/api/projects/${PA}/issues/${n}/spec/reviews`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ version: 1, verdict: "approve" }),
      },
    );
    expect(review.status).toBe(201);
    await markRead(PA, n);
    row = rowOf(await items(), PA, n);
    expect(row).toBeUndefined();
  });

  it("open questions pull an issue in until answered", async () => {
    const n = await createIssue(PB, "question for alice");
    const ask = await comment(PB, n, bob.headers, "which way?", {
      type: "questions",
      questions: [
        {
          question: "Pick one",
          options: [{ label: "left" }, { label: "right" }],
        },
      ],
    });
    expect(ask.status).toBe(201);
    const commentId = (await json(ask)).id;

    let row = rowOf(await items(), PB, n);
    expect(row).toMatchObject({ open_questions: 1 });

    const answer = await t.app.request(
      `/api/projects/${PB}/issues/${n}/comments/${commentId}/answers`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ answers: [{ key: "q1", selected: [0] }] }),
      },
    );
    expect(answer.status).toBe(201);
    await markRead(PB, n);
    row = rowOf(await items(), PB, n);
    expect(row).toBeUndefined();
  });

  it("scopes to explicit projects and 404s on unknown or foreign slugs", async () => {
    const a = await createIssue(PA, "scoped A");
    const b = await createIssue(PB, "scoped B");
    await comment(PA, a, bob.headers, "ping");
    await comment(PB, b, bob.headers, "ping");

    const scoped = await items(`?projects=${PA}`);
    expect(rowOf(scoped, PA, a)).toBeDefined();
    expect(rowOf(scoped, PB, b)).toBeUndefined();

    expect((await inbox("?projects=nope")).status).toBe(404);

    // A project the caller is no member of is indistinguishable from a
    // missing one — checked as a plain user, since the cookie account is
    // the instance admin and legitimately sees everything.
    const carol = await addUserWithToken(t.ctx, "inbox-carol");
    expect((await inbox(`?projects=${PA}`, carol.headers)).status).toBe(404);
    expect((await inbox("?projects=nope", carol.headers)).status).toBe(404);

    await markRead(PA, a);
    await markRead(PB, b);
  });

  it("caps per project and reports truncation", async () => {
    const nums: number[] = [];
    for (let i = 0; i < 3; i++) {
      const n = await createIssue(PB, `bulk ${i}`);
      await comment(PB, n, bob.headers, `noise ${i}`);
      await settle();
      nums.push(n);
    }

    const page = await items("?limit=2");
    const pbRows = page.items.filter(
      (i: { project: { slug: string } }) => i.project.slug === PB,
    );
    expect(pbRows).toHaveLength(2);
    expect(page.truncated).toBe(true);
    // Newest two of the three survive the cut.
    expect(pbRows.map((r: { number: number }) => r.number)).toEqual([
      nums[2],
      nums[1],
    ]);

    const full = await items();
    expect(full.truncated).toBe(false);
    for (const n of nums) await markRead(PB, n);
  });

  it("works for machine accounts without special casing", async () => {
    const agent = await addUserWithToken(t.ctx, "inbox-agent", {
      kind: "machine",
      ownerId: bob.user.id,
    });
    const member = await t.app.request(
      `/api/projects/${PA}/members/${agent.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(member.status).toBe(204);

    const page = await items("", agent.headers);
    expect(page.items).toEqual([]);

    const n = await createIssue(PA, "for the agent");
    await comment(PA, n, headers(), "alice speaking");
    const after = await items("", agent.headers);
    expect(rowOf(after, PA, n)).toBeDefined();
  });
});
