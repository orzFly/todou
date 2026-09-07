import type { InboxRowState } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessibleProjectRows,
  type ProjectRow,
  routeInfoOf,
} from "../src/services/access.ts";
import { visibleProjects } from "../src/services/cross-references.ts";
import { inboxRowState } from "../src/services/inbox.ts";
import { readPrefs } from "../src/services/prefs.ts";
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

  // The SSE path judges one card at a time (T-273) while the list scans a
  // project. Two fetches, one rule — so the test that matters is not what
  // either answers, but that they never disagree. Since T-275 the single
  // path returns the whole row rather than a boolean, and clients compare it
  // field by field against the list's, so the agreement is checked field by
  // field too: a mismatch on any one of them reads as a badge that refuses
  // to move, or as a refetch on every event.
  describe("inboxRowState agrees with the list, field for field (T-275)", () => {
    // Its own project: an unreviewed spec is in everyone's inbox regardless
    // of read state, so these fixtures would follow later tests around.
    const PC = "inbox-judge";
    let project: ProjectRow;

    async function markReadAs(
      slug: string,
      number: number,
      who: Record<string, string>,
    ): Promise<void> {
      await settle();
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${number}/read`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", ...who },
          body: "{}",
        },
      );
      expect(res.status).toBe(204);
    }

    async function setWeakUnread(on: boolean): Promise<void> {
      const res = await t.app.request("/api/me/prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify({ show_weak_unread: on }),
      });
      expect(res.status).toBe(200);
    }

    /** The five deciding fields of the list's row, or null when it has none. */
    function listFingerprint(
      page: {
        items: {
          number: number;
          project: { slug: string };
          updated_at: string;
          unread: boolean;
          unread_comments: number;
          pending_spec_review: boolean;
          open_questions: number;
        }[];
      },
      number: number,
    ): InboxRowState | null {
      const row = page.items.find(
        (i) => i.project.slug === PC && i.number === number,
      );
      if (row === undefined) return null;
      return {
        updated_at: row.updated_at,
        unread: row.unread,
        unread_comments: row.unread_comments,
        pending_spec_review: row.pending_spec_review,
        open_questions: row.open_questions,
      };
    }

    /** Both paths' row for each card, for bob, as they stand right now. */
    async function fingerprints(
      numbers: number[],
    ): Promise<
      Record<
        number,
        { list: InboxRowState | null; single: InboxRowState | null }
      >
    > {
      const page = await items("", bob.headers);
      const db = await t.ctx.router.forProject(routeInfoOf(project));
      const prefs = await readPrefs(t.ctx.router.system(), bob.user.id);
      const visible = await visibleProjects(t.ctx, bob.user);
      const out: Record<
        number,
        { list: InboxRowState | null; single: InboxRowState | null }
      > = {};
      for (const n of numbers) {
        out[n] = {
          list: listFingerprint(page, n),
          single: await inboxRowState(db, project, bob.user, n, prefs, visible),
        };
      }
      return out;
    }

    /** Every card's two answers agree, and presence is what was expected. */
    async function expectAgreement(
      expected: Record<number, boolean>,
    ): Promise<
      Record<
        number,
        { list: InboxRowState | null; single: InboxRowState | null }
      >
    > {
      const seen = await fingerprints(Object.keys(expected).map(Number));
      for (const [key, present] of Object.entries(expected)) {
        const number = Number(key);
        const { list, single } = seen[number] as {
          list: InboxRowState | null;
          single: InboxRowState | null;
        };
        expect({ number, single }).toEqual({ number, single: list });
        expect({ number, present: single !== null }).toEqual({
          number,
          present,
        });
      }
      return seen;
    }

    beforeAll(async () => {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug: PC, name: "Inbox Judge" }),
      });
      expect(created.status).toBe(201);
      const member = await t.app.request(
        `/api/projects/${PC}/members/${bob.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);

      // Mints bob's frontier here before any fixture exists; without it
      // every card below would be dated before his epoch and read on
      // arrival.
      await items("", bob.headers);
      await settle();

      const rows = await accessibleProjectRows(t.ctx, bob.user);
      const row = rows.find((r) => r.slug === PC);
      if (!row) throw new Error(`bob cannot read ${PC}`);
      project = row;
    });

    it("covers every reason a card is in or out", async () => {
      // Alice is the foreign actor here; bob is the reader being judged.
      const unreadComment = await createIssue(PC, "alice wrote to bob");
      await comment(PC, unreadComment, headers(), "for bob");

      const ownActivity = await createIssueAs(PC, bob.headers, "bob's own");
      await comment(PC, ownActivity, bob.headers, "note to self");

      const closedQuestion = await createIssue(PC, "asked, then closed");
      await ask(PC, closedQuestion, headers(), "still worth it?");
      await setStatus(PC, closedQuestion, "closed");
      await markReadAs(PC, closedQuestion, bob.headers);

      const specForBob = await createIssue(PC, "spec awaiting bob");
      await pushSpec(PC, specForBob, headers());

      const specByBob = await createIssueAs(PC, bob.headers, "bob's own spec");
      await pushSpec(PC, specByBob, bob.headers);

      const trashed = await createIssue(PC, "unread, then deleted");
      await comment(PC, trashed, headers(), "about to vanish");
      const gone = await t.app.request(
        `/api/projects/${PC}/issues/${trashed}`,
        { method: "DELETE", headers: headers() },
      );
      expect(gone.status).toBe(204);

      const seen = await expectAgreement({
        [unreadComment]: true,
        [ownActivity]: false,
        [closedQuestion]: false,
        [specForBob]: true,
        [specByBob]: false,
        [trashed]: false,
      });

      // Agreement alone would also hold if both paths reported zeroes, so
      // the two reasons a row exists are pinned to their actual values.
      expect(seen[unreadComment]?.single).toMatchObject({
        unread: true,
        // The card opened by someone else counts as the first of them
        // (T-151), and the comment on it as the second.
        unread_comments: 2,
        pending_spec_review: false,
        open_questions: 0,
      });
      expect(seen[specForBob]?.single).toMatchObject({
        pending_spec_review: true,
      });

      await markReadAs(PC, unreadComment, bob.headers);
      await markReadAs(PC, specForBob, bob.headers);
    });

    // The one place the fingerprint's fields do not come from one source:
    // `pending_spec_review` is the keep-check's value, `open_questions` is
    // the raw column, because that is what the list's InboxItem carries.
    // A closed card with both an unreviewed foreign spec and unanswered
    // questions is where the two spellings visibly differ, so an
    // implementation that zeroed both would pass every other case here.
    it("keeps open_questions raw on a closed card that stays in", async () => {
      const closed = await createIssue(PC, "closed, asked, then answered to");
      await ask(PC, closed, headers(), "still open?");
      await pushSpec(PC, closed, headers());
      await setStatus(PC, closed, "closed");
      await markReadAs(PC, closed, bob.headers);
      // A foreign comment after the read position is the only reason a
      // closed card is still in the inbox (T-111).
      await settle();
      expect((await comment(PC, closed, headers(), "one more")).status).toBe(
        201,
      );

      const seen = await expectAgreement({ [closed]: true });
      expect(seen[closed]?.single).toMatchObject({
        unread: true,
        unread_comments: 1,
        // Retired by closing, so the reader is not sent to review it.
        pending_spec_review: false,
        // Still on the row, and still what the list reports.
        open_questions: 1,
      });

      await markReadAs(PC, closed, bob.headers);
    });

    // The premise of the "mark stale, do not refetch" branch: content edits
    // move `updated_at` and unpaired timeline entries do not, so the client
    // can tell "the row's card changed" from "nothing about the row changed".
    it("moves updated_at on a label change but not on a comment edit", async () => {
      const card = await createIssue(PC, "watch its updated_at");
      const commentId = (await json(
        await comment(PC, card, headers(), "first"),
      )) as { id: number };
      await settle();

      const before = await expectAgreement({ [card]: true });
      const label = (await json(
        await t.app.request(`/api/projects/${PC}/labels`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ name: "watched", color: "#336699" }),
        }),
      )) as { id: number };
      await settle();
      const labelled = await t.app.request(
        `/api/projects/${PC}/issues/${card}`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ label_ids: [label.id] }),
        },
      );
      expect(labelled.status).toBe(200);

      const afterLabel = await expectAgreement({ [card]: true });
      expect(afterLabel[card]?.single?.updated_at).not.toBe(
        before[card]?.single?.updated_at,
      );

      await settle();
      const edited = await t.app.request(
        `/api/projects/${PC}/issues/${card}/comments/${commentId.id}`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ body: "first, revised" }),
        },
      );
      expect(edited.status).toBe(200);

      const afterEdit = await expectAgreement({ [card]: true });
      expect(afterEdit[card]?.single?.updated_at).toBe(
        afterLabel[card]?.single?.updated_at,
      );

      await markReadAs(PC, card, bob.headers);
    });

    it("follows show_weak_unread on an open and a closed card", async () => {
      // Event-only news on a card bob has already read: the weak-unread
      // state the toggle governs. The closed one is the same shape after
      // T-111 has retired its other reasons — measured semantics, not a bug.
      const open = await createIssue(PC, "read, then retitled");
      const closed = await createIssue(PC, "read, then closed");
      await markReadAs(PC, open, bob.headers);
      await markReadAs(PC, closed, bob.headers);
      await settle();

      const retitle = await t.app.request(
        `/api/projects/${PC}/issues/${open}`,
        {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ title: "read, then retitled (again)" }),
        },
      );
      expect(retitle.status).toBe(200);
      await setStatus(PC, closed, "closed");

      for (const on of [true, false, true]) {
        await setWeakUnread(on);
        await expectAgreement({ [open]: on, [closed]: on });
      }

      await setWeakUnread(true);
      await markReadAs(PC, open, bob.headers);
      await markReadAs(PC, closed, bob.headers);
    });

    it("says null for a number nobody ever used", async () => {
      const db = await t.ctx.router.forProject(routeInfoOf(project));
      const prefs = await readPrefs(t.ctx.router.system(), bob.user.id);
      const visible = await visibleProjects(t.ctx, bob.user);
      expect(
        await inboxRowState(db, project, bob.user, 999_999, prefs, visible),
      ).toBeNull();
    });
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
