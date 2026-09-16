import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps in the DB carry µs; keep actions >1ms apart so read
 *  positions minted with ms-precision now() can never tie with them. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const P = "unread-a";

describe("mention unread T-373", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  async function createIssue(title: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${P}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  async function comment(
    who: Record<string, string>,
    number: number,
    body: string,
  ): Promise<{ id: number }> {
    const res = await t.app.request(
      `/api/projects/${P}/issues/${number}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(201);
    return json(res);
  }

  async function editComment(
    who: Record<string, string>,
    number: number,
    id: number,
    body: string,
  ): Promise<void> {
    const res = await t.app.request(
      `/api/projects/${P}/issues/${number}/comments/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(200);
  }

  /** The row bob sees for one card, on the issue list. */
  async function listItem(
    number: number,
  ): Promise<{ unread: boolean; unread_comments: number } | null> {
    const res = await t.app.request(
      `/api/projects/${P}/issues?numbers=${number}`,
      { headers: { ...bob.headers } },
    );
    expect(res.status).toBe(200);
    return (await json(res)).items[0] ?? null;
  }

  async function markReadAs(who: Record<string, string>, number: number) {
    await settle();
    const res = await t.app.request(
      `/api/projects/${P}/issues/${number}/read`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...who },
        body: "{}",
      },
    );
    expect(res.status).toBe(204);
  }

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: P, name: "Unread A" }),
    });
    expect(created.status).toBe(201);
    bob = await addUserWithToken(t.ctx, "unread-bob");
    const member = await t.app.request(
      `/api/projects/${P}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);
    // Mints bob's frontier before any fixture exists.
    const warm = await t.app.request("/api/me/inbox", {
      headers: { ...bob.headers },
    });
    expect(warm.status).toBe(200);
    await settle();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("an edit that adds a mention relights a read card", async () => {
    // THE reason mention is its own grade (design.md): an edit makes no new
    // comment and no event, so nothing else could wake this card.
    const n = await createIssue("relight witness");
    const c = await comment(headers(), n, "plain comment");
    await settle();
    await markReadAs(bob.headers, n);
    expect((await listItem(n))?.unread).toBe(false);

    await editComment(headers(), n, c.id, "now with @unread-bob inside");
    await settle();
    const after = await listItem(n);
    expect(after?.unread).toBe(true);
    // A mention is not a comment: the count stays at zero.
    expect(after?.unread_comments).toBe(0);
  });

  it("another reader's state is untouched", async () => {
    const n = await createIssue("others card");
    const c = await comment(headers(), n, "for @unread-bob");
    await settle();
    const mine = await t.app.request(`/api/projects/${P}/issues?numbers=${n}`, {
      headers: headers(),
    });
    expect(((await json(mine)).items[0] as { unread: boolean }).unread).toBe(
      false,
    );
    void c;
  });

  it("a self-mention does not light the card", async () => {
    // Bob's own card, so the only activity on it is hers: the self-mention
    // is then the only thing that COULD light it, and must not.
    const res = await t.app.request(`/api/projects/${P}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bob.headers },
      body: JSON.stringify({ title: "self card" }),
    });
    expect(res.status).toBe(201);
    const n = (await json(res)).number as number;
    await comment(bob.headers, n, "note @unread-bob myself");
    await settle();
    expect((await listItem(n))?.unread).toBe(false);
  });

  it("mark-read quiets a mention", async () => {
    const n = await createIssue("quiet card");
    await comment(headers(), n, "hey @unread-bob");
    await settle();
    expect((await listItem(n))?.unread).toBe(true);
    await markReadAs(bob.headers, n);
    expect((await listItem(n))?.unread).toBe(false);
  });
});
