import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import { issueMentions, issues } from "../src/db/project-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const P = "mention-a";

describe("mentions T-373", () => {
  let t: TestApp;
  let db: Db;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  let outsider: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  /** The internal row id of card `number` — the key issue_mentions uses. */
  async function issueIdOf(number: number): Promise<number> {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, 1), eq(issues.number, number)));
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`card ${number} not found`);
    return id;
  }

  async function rowsOf(number: number) {
    const issueId = await issueIdOf(number);
    return db
      .select()
      .from(issueMentions)
      .where(eq(issueMentions.issueId, issueId));
  }

  async function createIssue(title: string, body = ""): Promise<number> {
    const res = await t.app.request(`/api/projects/${P}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  async function comment(
    who: Record<string, string>,
    number: number,
    body: string,
  ): Promise<{ id: number; body: string }> {
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
  ): Promise<{ id: number; body: string }> {
    const res = await t.app.request(
      `/api/projects/${P}/issues/${number}/comments/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(200);
    return json(res);
  }

  async function getComment(
    who: Record<string, string>,
    number: number,
    id: number,
  ): Promise<{ body: string }> {
    const res = await t.app.request(
      `/api/projects/${P}/issues/${number}/comments/${id}`,
      { headers: who },
    );
    expect(res.status).toBe(200);
    return json(res);
  }

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: P, name: "Mention A" }),
    });
    expect(created.status).toBe(201);
    bob = await addUserWithToken(t.ctx, "m311-bob");
    outsider = await addUserWithToken(t.ctx, "m311-out");
    for (const user of [bob, outsider]) {
      const res = await t.app.request(
        `/api/projects/${P}/members/${user.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(res.status).toBe(204);
    }
    // Mints bob's frontier before any fixture exists: a mention older than
    // this moment never counts as unread (T-35 bootstrap semantics).
    const warm = await t.app.request("/api/me/inbox", {
      headers: { ...bob.headers },
    });
    expect(warm.status).toBe(200);
    db = await t.ctx.router.forProject({ id: 1, slug: P, database_url: "" });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("stores a member mention as an id-anchored link", async () => {
    const n = await createIssue("plain card");
    const saved = await comment(headers(), n, "ping @m311-bob");
    expect(saved.body).toBe(`ping [@m311-bob](/users/${bob.user.id})`);
  });

  it("keeps a non-member and an unknown login as text", async () => {
    const n = await createIssue("plain card 2");
    const saved = await comment(headers(), n, "hi @stranger and @nobody");
    expect(saved.body).toBe("hi @stranger and @nobody");
  });

  it("keeps the typed case as link text, the id as address", async () => {
    const n = await createIssue("case card");
    const saved = await comment(headers(), n, "hey @M311-BOB!");
    expect(saved.body).toBe(`hey [@M311-BOB](/users/${bob.user.id})!`);
  });

  it("is idempotent: re-saving the stored text changes no byte", async () => {
    const n = await createIssue("idempotent card");
    const saved = await comment(headers(), n, "ping @m311-bob");
    const again = await editComment(headers(), n, saved.id, saved.body);
    expect(again.body).toBe(saved.body);
    const read = await getComment(headers(), n, saved.id);
    expect(read.body).toBe(saved.body);
  });

  it("survives a rename: stored bytes unchanged, wire reports new login", async () => {
    // The card's central promise (design.md): a rename changes what readers
    // see, never what is stored.
    const n = await createIssue("rename witness");
    const saved = await comment(headers(), n, "ping @m311-bob");
    const rename = await t.app.request("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob.headers },
      body: JSON.stringify({ login: "m311-robert" }),
    });
    expect(rename.status).toBe(200);
    expect((await json(rename)).login).toBe("m311-robert");
    const read = await getComment(headers(), n, saved.id);
    expect(read.body).toBe(saved.body);
    const profile = await t.app.request(`/api/users/${bob.user.id}`, {
      headers: headers(),
    });
    expect((await json(profile)).login).toBe("m311-robert");
    // Rename back so later fixtures keep addressing by login.
    const back = await t.app.request("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob.headers },
      body: JSON.stringify({ login: "m311-bob" }),
    });
    expect(back.status).toBe(200);
  });

  it("leaves @ inside code regions alone", async () => {
    const n = await createIssue("code card");
    const saved = await comment(
      headers(),
      n,
      "see `@m311-bob` and\n\n```\n@m311-bob\n```\nbut @m311-bob outside",
    );
    expect(saved.body).toBe(
      "see `@m311-bob` and\n\n```\n@m311-bob\n```\nbut [@m311-bob](/users/" +
        bob.user.id +
        ") outside",
    );
  });

  it("records one row per mentioned user, on the comment", async () => {
    const n = await createIssue("rows card");
    await comment(headers(), n, "ping @m311-bob and @m311-bob again");
    const rows = await rowsOf(n);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commentId).not.toBeNull();
    expect(rows[0]?.userId).toBe(bob.user.id);
  });

  it("edits add only the new mention; removal deletes nothing", async () => {
    const n = await createIssue("edit card");
    const first = await comment(headers(), n, "ping @m311-bob");
    await editComment(headers(), n, first.id, "ping @m311-bob and @m311-out");
    const afterAdd = await rowsOf(n);
    expect(afterAdd.map((r) => r.userId).sort()).toEqual(
      [bob.user.id, outsider.user.id].sort(),
    );

    await editComment(headers(), n, first.id, "no pings at all now");
    expect(await rowsOf(n)).toHaveLength(afterAdd.length);

    // A re-save of the same text adds nothing beyond what exists.
    await editComment(headers(), n, first.id, "no pings at all now");
    expect(await rowsOf(n)).toHaveLength(afterAdd.length);
  });

  it("never records the author mentioning themselves, but links them", async () => {
    const n = await createIssue("self card");
    const saved = await comment(bob.headers, n, "note for @m311-bob");
    expect(saved.body).toBe(`note for [@m311-bob](/users/${bob.user.id})`);
    expect(await rowsOf(n)).toHaveLength(0);
  });

  it("expands spec-file mentions into links but records no row", async () => {
    const n = await createIssue("spec card");
    const push = await t.app.request(
      `/api/projects/${P}/issues/${n}/spec/push`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          files: [{ path: "design.md", body: "written by @m311-bob" }],
          message: "v1",
        }),
      },
    );
    expect(push.status).toBe(200);
    const files = await t.app.request(
      `/api/projects/${P}/issues/${n}/spec/files`,
      { headers: headers() },
    );
    expect(files.status).toBe(200);
    const body = (await json(files)).files[0].body as string;
    expect(body).toBe(`written by [@m311-bob](/users/${bob.user.id})`);
    expect(await rowsOf(n)).toHaveLength(0);
  });

  it("drops mention rows with the comment; a trashed card leaves the inbox", async () => {
    const n1 = await createIssue("delete comment card");
    const c1 = await comment(headers(), n1, "ping @m311-bob");
    expect((await rowsOf(n1)).map((r) => r.userId)).toEqual([bob.user.id]);
    await t.app.request(`/api/projects/${P}/issues/${n1}/comments/${c1.id}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(await rowsOf(n1)).toHaveLength(0);

    // Soft delete keeps the rows (a restore brings the card back with its
    // history), and the read side's own `live` gate is what keeps a trashed
    // card out of the inbox — the same contract unread comments live under.
    const n2 = await createIssue("trash card", "for @m311-bob from the body");
    expect((await rowsOf(n2)).map((r) => r.userId)).toEqual([bob.user.id]);
    const inboxBefore = await t.app.request("/api/me/inbox", {
      headers: { ...bob.headers },
    });
    expect(inboxBefore.status).toBe(200);
    const before = (await json(inboxBefore)).items as Array<{
      number: number;
      mentions_you: boolean;
    }>;
    expect(before.find((i) => i.number === n2)?.mentions_you).toBe(true);
    const trashed = await t.app.request(`/api/projects/${P}/issues/${n2}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(trashed.status).toBe(204);
    const inboxAfter = await t.app.request("/api/me/inbox", {
      headers: { ...bob.headers },
    });
    const after = (await json(inboxAfter)).items as Array<{ number: number }>;
    expect(after.find((i) => i.number === n2)).toBeUndefined();
    // The rows themselves are untouched: `deleted_at` is a soft delete, so
    // the `issue_id` cascade never fires. Asserted rather than assumed,
    // because it is the half the restore below depends on.
    expect((await rowsOf(n2)).map((r) => r.userId)).toEqual([bob.user.id]);

    const restored = await t.app.request(
      `/api/projects/${P}/issues/${n2}/restore`,
      { method: "POST", headers: headers() },
    );
    expect(restored.status).toBe(200);
    const inboxBack = await t.app.request("/api/me/inbox", {
      headers: { ...bob.headers },
    });
    const back = (await json(inboxBack)).items as Array<{
      number: number;
      mentions_you: boolean;
    }>;
    expect(back.find((i) => i.number === n2)?.mentions_you).toBe(true);
  });

  it("records body mentions with a null comment_id", async () => {
    const n = await createIssue("body card", "for @m311-bob from the top post");
    const rows = await rowsOf(n);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commentId).toBeNull();
    expect(rows[0]?.userId).toBe(bob.user.id);
  });
});
