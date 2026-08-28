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

  async function createIssueAs(
    slug: string,
    who: Record<string, string>,
    title: string,
  ): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  async function createIssue(slug: string, title: string): Promise<number> {
    return createIssueAs(slug, headers(), title);
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

  type Category = "open" | "closed";
  const statusIds = new Map<string, number>();

  /** First status of `category` in the project, memoized per project. */
  async function statusOf(slug: string, category: Category): Promise<number> {
    const key = `${slug}:${category}`;
    const cached = statusIds.get(key);
    if (cached !== undefined) return cached;
    const rows = await json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: { cookie },
      }),
    );
    const id = rows.find((s: { category: string }) => s.category === category)
      .id as number;
    statusIds.set(key, id);
    return id;
  }

  async function setStatus(
    slug: string,
    number: number,
    category: Category,
  ): Promise<void> {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status_id: await statusOf(slug, category) }),
    });
    expect(res.status).toBe(200);
  }

  async function pushSpec(
    slug: string,
    number: number,
    who: Record<string, string>,
    message = "v1",
  ): Promise<void> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/push`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify({
          files: [{ path: "design.md", body: `# ${message}` }],
          message,
        }),
      },
    );
    expect(res.status).toBe(200);
  }

  async function ask(
    slug: string,
    number: number,
    who: Record<string, string>,
    body: string,
  ): Promise<number> {
    const res = await comment(slug, number, who, body, {
      type: "questions",
      questions: [
        {
          question: "Pick one",
          options: [{ label: "left" }, { label: "right" }],
        },
      ],
    });
    expect(res.status).toBe(201);
    return (await json(res)).id;
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

  it("a card someone else opened outlives the weak toggle (T-151)", async () => {
    const n = await createIssueAs(PA, bob.headers, "bob's brand-new card");

    const off = await t.app.request("/api/me/prefs", {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ show_weak_unread: false }),
    });
    expect(off.status).toBe(200);
    // Nobody has replied yet — the top post is the single unread comment,
    // and that is what keeps the row out of the weak-unread bucket.
    expect(rowOf(await items(), PA, n)).toMatchObject({
      unread: true,
      unread_comments: 1,
    });

    await markRead(PA, n);
    expect(rowOf(await items(), PA, n)).toBeUndefined();

    const on = await t.app.request("/api/me/prefs", {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ show_weak_unread: true }),
    });
    expect(on.status).toBe(200);
    expect(rowOf(await items(), PA, n)).toBeUndefined();
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
    await setStatus(PA, n, "closed");

    const row = rowOf(await items(), PA, n);
    expect(row).toMatchObject({ unread: true, status: { category: "closed" } });
    await markRead(PA, n);
  });

  it("specs pushed by others await my review; my own never do", async () => {
    const n = await createIssue(PA, "spec by bob");
    await pushSpec(PA, n, bob.headers);

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
    const commentId = await ask(PB, n, bob.headers, "which way?");

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

  it("closing an issue retires a spec waiting for my review (T-111)", async () => {
    const n = await createIssue(PA, "spec then closed");
    await pushSpec(PA, n, bob.headers);
    expect(rowOf(await items(), PA, n)).toMatchObject({
      pending_spec_review: true,
    });

    await setStatus(PA, n, "closed");
    // Reading clears the unread left by bob's push; the pending review is
    // then the only reason left, and closing has retired it.
    await markRead(PA, n);
    expect(rowOf(await items(), PA, n)).toBeUndefined();

    // The exception: a genuinely new comment brings the issue back — but it
    // no longer claims to be waiting for a review.
    await comment(PA, n, bob.headers, "one more thought");
    expect(rowOf(await items(), PA, n)).toMatchObject({
      unread: true,
      unread_comments: 1,
      pending_spec_review: false,
    });
    await markRead(PA, n);

    // Still unreviewed on the issue itself — only its claim on the inbox
    // went away, and reopening restores it.
    await setStatus(PA, n, "open");
    expect(rowOf(await items(), PA, n)).toMatchObject({
      pending_spec_review: true,
    });
    await setStatus(PA, n, "closed");
    await markRead(PA, n);
  });

  it("closing an issue retires its open questions (T-111)", async () => {
    const n = await createIssue(PB, "question then closed");
    await ask(PB, n, bob.headers, "still relevant?");
    expect(rowOf(await items(), PB, n)).toMatchObject({ open_questions: 1 });

    await setStatus(PB, n, "closed");
    await markRead(PB, n);
    expect(rowOf(await items(), PB, n)).toBeUndefined();

    // Unanswered all along: the row reports the question truthfully when a
    // new comment pulls the issue back in, it just cannot pull on its own.
    await comment(PB, n, bob.headers, "ping");
    expect(rowOf(await items(), PB, n)).toMatchObject({
      open_questions: 1,
      unread_comments: 1,
    });
    await markRead(PB, n);
    expect(rowOf(await items(), PB, n)).toBeUndefined();
  });

  it("a closed issue's pending rows stay gone with weak unread on (T-111)", async () => {
    // show_weak_unread defaults to on, but the toggle must not resurrect
    // what closing retired: with the spec/question reasons neutralized,
    // there has to be real unread activity behind every closed row.
    const n = await createIssue(PA, "closed, weak toggle on");
    await pushSpec(PA, n, bob.headers);
    await ask(PA, n, bob.headers, "worth finishing?");
    await setStatus(PA, n, "closed");
    await markRead(PA, n);

    for (const on of [true, false, true]) {
      const res = await t.app.request("/api/me/prefs", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ show_weak_unread: on }),
      });
      expect(res.status).toBe(200);
      expect(rowOf(await items(), PA, n)).toBeUndefined();
    }
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
