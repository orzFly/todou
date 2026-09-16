import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silenced } from "../src/services/mutes.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps in the DB carry µs; keep actions >1ms apart so read
 *  positions minted with ms-precision now() can never tie with them. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const PA = "mute-a";
const PB = "mute-b";

describe("mutes T-372", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  const inbox = async (
    who?: Record<string, string>,
  ): Promise<{ items: { number: number; project: { slug: string } }[] }> => {
    const res = await t.app.request("/api/me/inbox", {
      headers: who ?? { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  const inInbox = async (
    slug: string,
    number: number,
    who?: Record<string, string>,
  ): Promise<boolean> => {
    const page = await inbox(who);
    return page.items.some(
      (i) => i.project.slug === slug && i.number === number,
    );
  };

  /** The list item for one card, as the reader sees it. */
  const listItem = async (
    slug: string,
    number: number,
    who?: Record<string, string>,
  ): Promise<{
    unread: boolean;
    unread_comments: number;
    muted: string | null;
  } | null> => {
    const res = await t.app.request(
      `/api/projects/${slug}/issues?numbers=${number}`,
      { headers: who ?? { cookie } },
    );
    expect(res.status).toBe(200);
    const page = await json(res);
    return page.items[0] ?? null;
  };

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

  const mute = (
    slug: string,
    number: number,
    mode: string,
    who?: Record<string, string>,
  ) =>
    t.app.request(`/api/projects/${slug}/issues/${number}/mute`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(who ?? headers()) },
      body: JSON.stringify({ mode }),
    });

  const unmute = (slug: string, number: number, who?: Record<string, string>) =>
    t.app.request(`/api/projects/${slug}/issues/${number}/mute`, {
      method: "DELETE",
      headers: who ?? { cookie },
    });

  const muteProject = (slug: string, who?: Record<string, string>) =>
    t.app.request(`/api/projects/${slug}/mute`, {
      method: "PUT",
      headers: who ?? { cookie },
    });

  const unmuteProject = (slug: string, who?: Record<string, string>) =>
    t.app.request(`/api/projects/${slug}/mute`, {
      method: "DELETE",
      headers: who ?? { cookie },
    });

  const mutesOf = async (who?: Record<string, string>) => {
    const res = await t.app.request("/api/me/mutes", {
      headers: who ?? { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  const pushSpec = async (
    slug: string,
    number: number,
    who: Record<string, string>,
    message = "v1",
  ): Promise<void> => {
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
  };

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const [slug, name] of [
      [PA, "Mute A"],
      [PB, "Mute B"],
    ] as const) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name }),
      });
      expect(res.status).toBe(201);
    }
    bob = await addUserWithToken(t.ctx, "mute-bob");
    for (const slug of [PA, PB]) {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${bob.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect([200, 204]).toContain(res.status);
    }
    // First call mints both frontiers: history up to here never counts.
    const page = await inbox();
    expect(page.items).toEqual([]);
    await settle();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("forever: unread stays truthful, the card leaves the inbox", async () => {
    const n = await createIssueAs(PA, headers(), "forever mute");
    await settle();
    await comment(PA, n, bob.headers, "hello from bob");
    await settle();

    const res = await mute(PA, n, "forever");
    expect(res.status).toBe(204);
    await settle();

    const item = await listItem(PA, n);
    expect(item?.unread).toBe(true);
    expect(item?.unread_comments).toBe(1);
    expect(item?.muted).toBe("forever");
    expect(await inInbox(PA, n)).toBe(false);
  });

  it("until_activity: relights on foreign activity, unread_comments keeps counting", async () => {
    const n = await createIssueAs(PA, headers(), "until_activity mute");
    await settle();
    await comment(PA, n, bob.headers, "one");
    await comment(PA, n, bob.headers, "two");
    await settle();

    // Never read: both comments are unread against the frontier, and the
    // mute below is what suppresses them — the read position is never
    // touched, which is what the count of 3 below is there to prove.
    expect(await inInbox(PA, n)).toBe(true);
    const res = await mute(PA, n, "until_activity");
    expect(res.status).toBe(204);
    await settle();

    // Suppressed now…
    const muted = await listItem(PA, n);
    expect(muted?.muted).toBe("until_activity");
    expect(muted?.unread_comments).toBe(2);
    expect(await inInbox(PA, n)).toBe(false);

    // …and one more foreign comment relights it: all three count, the
    // gate never moved the read position.
    await comment(PA, n, bob.headers, "three");
    await settle();
    const relit = await listItem(PA, n);
    expect(relit?.muted).toBeNull();
    expect(relit?.unread_comments).toBe(3);
    expect(await inInbox(PA, n)).toBe(true);
  });

  it("own activity does not relight an until_activity mute", async () => {
    const n = await createIssueAs(PA, headers(), "own activity");
    await settle();
    await comment(PA, n, bob.headers, "seed");
    await settle();
    await mute(PA, n, "until_activity");
    await settle();
    expect(await inInbox(PA, n)).toBe(false);

    await comment(PA, n, headers(), "talking to myself");
    await settle();
    expect(await listItem(PA, n)).toMatchObject({ muted: "until_activity" });
    expect(await inInbox(PA, n)).toBe(false);
  });

  it("an open question or a foreign pending spec leaves with a mute, and a new version brings it back", async () => {
    // Question card, asked by bob.
    const q = await createIssueAs(PA, headers(), "question card");
    await settle();
    const ask = await comment(PA, q, bob.headers, "which one?", {
      type: "questions",
      questions: [
        {
          question: "Pick one",
          options: [{ label: "left" }, { label: "right" }],
        },
      ],
    });
    expect(ask.status).toBe(201);
    await settle();
    expect(await inInbox(PA, q)).toBe(true);

    await mute(PA, q, "forever");
    await settle();
    expect(await inInbox(PA, q)).toBe(false);

    // Spec card, pushed by bob, unreviewed.
    const s = await createIssueAs(PA, headers(), "spec card");
    await settle();
    await pushSpec(PA, s, bob.headers);
    await settle();
    expect(await inInbox(PA, s)).toBe(true);

    await mute(PA, s, "until_activity");
    await settle();
    expect(await inInbox(PA, s)).toBe(false);

    await pushSpec(PA, s, bob.headers, "v2");
    await settle();
    expect(await inInbox(PA, s)).toBe(true);

    // Reading the relit part quiets the card again (design.md): the v2
    // event is now below the reader's position, so the gate re-engages —
    // an event-only relight must not stick an until_activity card in the
    // inbox forever.
    const read = await t.app.request(`/api/projects/${PA}/issues/${s}/read`, {
      method: "PUT",
      headers: headers(),
      body: "{}",
    });
    expect(read.status).toBe(204);
    await settle();
    const quiet = await listItem(PA, s);
    expect(quiet?.muted).toBe("until_activity");
    expect(await inInbox(PA, s)).toBe(false);
  });

  it("project mute silences every card of the project and nobody else's", async () => {
    const inA = await createIssueAs(PA, headers(), "in A");
    const inB = await createIssueAs(PB, headers(), "in B");
    await settle();
    await comment(PA, inA, bob.headers, "noise");
    await comment(PB, inB, bob.headers, "signal");
    await settle();
    expect(await inInbox(PA, inA)).toBe(true);
    expect(await inInbox(PB, inB)).toBe(true);

    const res = await muteProject(PA);
    expect(res.status).toBe(204);
    await settle();

    const a = await listItem(PA, inA);
    expect(a?.muted).toBe("project");
    expect(await inInbox(PA, inA)).toBe(false);

    const b = await listItem(PB, inB);
    expect(b?.muted).toBeNull();
    expect(await inInbox(PB, inB)).toBe(true);

    await unmuteProject(PA);
    await settle();
    expect(await inInbox(PA, inA)).toBe(true);
  });

  it("DELETE restores exactly the pre-mute unread state", async () => {
    const n = await createIssueAs(PA, headers(), "unmute restores");
    await settle();
    await comment(PA, n, bob.headers, "one");
    await comment(PA, n, bob.headers, "two");
    await settle();
    await mute(PA, n, "forever");
    await settle();
    const during = await listItem(PA, n);
    expect(during?.muted).toBe("forever");

    const res = await unmute(PA, n);
    expect(res.status).toBe(204);
    await settle();
    const after = await listItem(PA, n);
    expect(after?.muted).toBeNull();
    expect(after?.unread_comments).toBe(during?.unread_comments);
    expect(await inInbox(PA, n)).toBe(true);
  });

  it("repeat PUT pushes muted_at; DELETE on a never-muted card is 204", async () => {
    const n = await createIssueAs(PA, headers(), "idempotence");
    await settle();
    await comment(PA, n, bob.headers, "before first mute");
    await settle();
    await mute(PA, n, "until_activity");
    await settle();

    // This comment relights the card…
    await comment(PA, n, bob.headers, "relighting");
    await settle();
    expect(await listItem(PA, n)).toMatchObject({ muted: null });

    // …and re-muting — the same PUT — buries it again, which only works
    // when the repeat write moved muted_at forward.
    const again = await mute(PA, n, "until_activity");
    expect(again.status).toBe(204);
    await settle();
    expect(await listItem(PA, n)).toMatchObject({ muted: "until_activity" });

    const stranger = await createIssueAs(PA, headers(), "never muted");
    await settle();
    const del = await unmute(PA, stranger);
    expect(del.status).toBe(204);
  });

  it("GET /me/mutes lists both kinds, scoped to readable projects", async () => {
    const n = await createIssueAs(PA, headers(), "listed mute");
    await settle();
    await mute(PA, n, "forever");
    await muteProject(PB);
    await settle();

    const mine = await mutesOf();
    const issue = mine.issues.find((i: { number: number }) => i.number === n);
    expect(issue).toMatchObject({
      project: { slug: PA },
      mode: "forever",
      title: "listed mute",
    });
    expect(mine.projects).toContainEqual(expect.objectContaining({ slug: PB }));

    // A reader with no role in PB never sees that project's mute row.
    const outsider = await addUserWithToken(t.ctx, "mute-outsider");
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "mute-c", name: "Mute C" }),
    });
    expect(res.status).toBe(201);
    const theirs = await mutesOf(outsider.headers);
    expect(theirs.issues).toHaveLength(0);
    expect(theirs.projects).toHaveLength(0);
  });

  it("the silenced() truth table", () => {
    const at = new Date("2026-01-02T00:00:00Z");
    const before = new Date("2026-01-01T00:00:00Z");
    const after = new Date("2026-01-03T00:00:00Z");

    expect(silenced(undefined, false, undefined)).toBeNull();
    expect(silenced(undefined, false, after)).toBeNull();
    expect(silenced(undefined, true, after)).toBe("project");
    expect(silenced({ mode: "forever", mutedAt: at }, false, after)).toBe(
      "forever",
    );
    expect(
      silenced({ mode: "until_activity", mutedAt: at }, false, undefined),
    ).toBe("until_activity");
    expect(
      silenced({ mode: "until_activity", mutedAt: at }, false, before),
    ).toBe("until_activity");
    expect(
      silenced({ mode: "until_activity", mutedAt: at }, false, after),
    ).toBeNull();
    // Project mute wins over everything: no per-card exception exists.
    expect(
      silenced({ mode: "until_activity", mutedAt: at }, true, before),
    ).toBe("project");
  });
});
