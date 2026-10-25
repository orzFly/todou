import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Keep writes >1ms apart from read positions minted with ms-precision now(). */
const settle = () => new Promise((r) => setTimeout(r, 5));

const P = "actions-a";
const Q = "actions-b";

/** `/me` lines (T-575): a comment of kind `action`. */
describe("actions", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const admin = () => ({ "content-type": "application/json", cookie });
  const asBob = () => ({ "content-type": "application/json", ...bob.headers });

  const req = (path: string, headers: Record<string, string>, init = {}) =>
    t.app.request(`/api${path}`, { headers, ...init });

  async function createIssue(slug: string, title: string): Promise<number> {
    const res = await req(`/projects/${slug}/issues`, admin(), {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  const post = (
    number: number,
    body: Record<string, unknown>,
    who: Record<string, string> = asBob(),
  ) =>
    req(`/projects/${P}/issues/${number}/comments`, who, {
      method: "POST",
      body: JSON.stringify(body),
    });

  async function timeline(slug: string, number: number) {
    const res = await req(
      `/projects/${slug}/issues/${number}/timeline?limit=100`,
      admin(),
    );
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test-side response poking
    return ((await json(res)).items as any[]).filter(
      (i) => i.type === "comment",
    );
  }

  async function markRead(number: number) {
    await settle();
    const res = await req(`/projects/${P}/issues/${number}/read`, admin(), {
      method: "PUT",
      body: "{}",
    });
    expect(res.status).toBe(204);
  }

  async function listRow(number: number) {
    const res = await req(`/projects/${P}/issues?numbers=${number}`, admin());
    return (await json(res)).items[0] as {
      unread: boolean;
      unread_comments: number;
    };
  }

  async function inboxHas(number: number): Promise<boolean> {
    const res = await req("/me/inbox", admin());
    expect(res.status).toBe(200);
    return (await json(res)).items.some(
      (i: { number: number; project: { slug: string } }) =>
        i.number === number && i.project.slug === P,
    );
  }

  async function setWeak(on: boolean) {
    const res = await req("/me/prefs", admin(), {
      method: "PATCH",
      body: JSON.stringify({ show_weak_unread: on }),
    });
    expect(res.status).toBe(200);
  }

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of [P, Q]) {
      const created = await req("/projects", admin(), {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(created.status).toBe(201);
    }
    bob = await addUserWithToken(t.ctx, "actions-bob");
    const member = await req(`/projects/${P}/members/${bob.user.id}`, admin(), {
      method: "PUT",
      body: JSON.stringify({ role: "writer" }),
    });
    expect(member.status).toBe(204);
    // Mint the admin's frontier before any fixture exists.
    expect((await req("/me/inbox", admin())).status).toBe(200);
    await settle();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("stores the trimmed text and says what it is", async () => {
    const n = await createIssue(P, "kind witness");
    const action = await post(n, { body: "  is reviewing.  ", kind: "action" });
    expect(action.status).toBe(201);
    expect(await json(action)).toMatchObject({
      kind: "action",
      body: "is reviewing.",
    });
    expect((await post(n, { body: "plain" })).status).toBe(201);

    expect((await timeline(P, n)).map((c) => [c.kind, c.body])).toEqual([
      ["action", "is reviewing."],
      ["comment", "plain"],
    ]);
  });

  it.each([
    ["a second line", { body: "is reviewing\nand more", kind: "action" }],
    ["too long", { body: "x".repeat(501), kind: "action" }],
    ["blank", { body: "   ", kind: "action" }],
    [
      "a component",
      {
        body: "asks",
        kind: "action",
        component: {
          type: "questions",
          questions: [
            { question: "?", options: [{ label: "a" }, { label: "b" }] },
          ],
        },
      },
    ],
    ["an unknown kind", { body: "hi", kind: "shout" }],
  ])("refuses an action with %s", async (_what, body) => {
    const n = await createIssue(P, "refusals");
    const res = await post(n, body);
    expect(res.status).toBe(422);
    expect(await timeline(P, n)).toEqual([]);
  });

  it("takes 500 characters, counted as code points", async () => {
    const n = await createIssue(P, "limit");
    const text = "土".repeat(250) + "🥔".repeat(250);
    expect((await post(n, { body: text, kind: "action" })).status).toBe(201);
  });

  it("is weak unread: the card lights, the comment count stays zero", async () => {
    const n = await createIssue(P, "weak witness");
    await markRead(n);
    await settle();
    expect((await post(n, { body: "is on it.", kind: "action" })).status).toBe(
      201,
    );
    expect(await listRow(n)).toMatchObject({
      unread: true,
      unread_comments: 0,
    });
    expect(await inboxHas(n)).toBe(true);

    await setWeak(false);
    expect(await inboxHas(n)).toBe(false);

    // The comment that follows is the strong one.
    expect((await post(n, { body: "done, see diff" })).status).toBe(201);
    expect(await listRow(n)).toMatchObject({
      unread: true,
      unread_comments: 1,
    });
    expect(await inboxHas(n)).toBe(true);
    await setWeak(true);
    await markRead(n);
  });

  it("stays a one-line action through edits", async () => {
    const n = await createIssue(P, "edit witness");
    const created = await json(
      await post(n, { body: "is reviewing.", kind: "action" }),
    );
    const patch = (body: string) =>
      req(`/projects/${P}/issues/${n}/comments/${created.id}`, asBob(), {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
    expect((await patch("is reviewing\nthe whole thing")).status).toBe(422);
    const edited = await patch(" is testing. ");
    expect(edited.status).toBe(200);
    expect(await json(edited)).toMatchObject({
      kind: "action",
      body: "is testing.",
    });
    const del = await req(
      `/projects/${P}/issues/${n}/comments/${created.id}`,
      asBob(),
      { method: "DELETE" },
    );
    expect(del.status).toBe(204);
  });

  it("lands with slash commands in one submission", async () => {
    const n = await createIssue(P, "commands witness");
    const statuses = (await json(
      await req(`/projects/${P}/statuses`, admin()),
    )) as Array<{ id: number; name: string }>;
    const inProgress = statuses.find((s) => s.name === "In Progress");
    expect(inProgress).toBeDefined();
    const submit = (body: Record<string, unknown>) =>
      req(`/projects/${P}/issues/${n}/commands`, asBob(), {
        method: "POST",
        body: JSON.stringify(body),
      });

    expect(
      (
        await submit({
          body: "",
          kind: "action",
          commands: [{ type: "status", status_id: inProgress?.id }],
        })
      ).status,
    ).toBe(422);

    const res = await submit({
      body: "is reviewing.",
      kind: "action",
      commands: [{ type: "status", status_id: inProgress?.id }],
    });
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result.comment).toMatchObject({
      kind: "action",
      body: "is reviewing.",
    });
    expect(result.issue.status.name).toBe("In Progress");
  });

  it("is still an action after the card moves", async () => {
    const n = await createIssue(P, "move witness");
    expect(
      (await post(n, { body: "is packing.", kind: "action" }, admin())).status,
    ).toBe(201);
    const res = await req(`/projects/${P}/issues/${n}/move`, admin(), {
      method: "POST",
      body: JSON.stringify({ to_project: Q }),
    });
    expect(res.status).toBe(200);
    const to = (await json(res)).moved_to.number as number;
    expect((await timeline(Q, to)).map((c) => [c.kind, c.body])).toEqual([
      ["action", "is packing."],
    ]);
  });
});
