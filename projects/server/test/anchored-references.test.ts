import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * Text that already carries the stored form `[T-N](/projects/<id>/issues/N)`
 * (T-554). Every read returns that form, so an author who copies a reference
 * out of one card into another submits it already anchored. The pass leaves
 * it byte for byte, and the target still has to hear about it under the same
 * rules a typed `#N` goes through.
 */
describe("references submitted already anchored (T-554)", () => {
  let t: TestApp;
  let cookie: string;
  let outsider: Awaited<ReturnType<typeof addUserWithToken>>;
  const HERE = "anchored-here";
  const THERE = "anchored-there";
  const WALLED = "anchored-walled";
  const id: Record<string, number> = {};

  const req = (
    path: string,
    init?: RequestInit,
    who: Record<string, string> = { cookie },
  ) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", ...who }
        : who,
    });

  const createIssue = async (
    slug: string,
    title: string,
    body = "",
    who?: Record<string, string>,
  ) => {
    const res = await req(
      `/projects/${slug}/issues`,
      { method: "POST", body: JSON.stringify({ title, body }) },
      who,
    );
    expect(res.status).toBe(201);
    return (await json(res)) as { number: number; body: string };
  };

  const addComment = async (slug: string, number: number, body: string) => {
    const res = await req(`/projects/${slug}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; body: string };
  };

  const editBody = async (slug: string, number: number, body: string) => {
    const res = await req(`/projects/${slug}/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(200);
    return (await json(res)) as { body: string };
  };

  const referenced = async (slug: string, number: number) => {
    const res = await req(
      `/projects/${slug}/issues/${number}/timeline?types=referenced&limit=100`,
    );
    expect(res.status).toBe(200);
    return (await json(res)).items as Array<{
      payload: Record<string, unknown>;
    }>;
  };

  const anchored = (slug: string, number: number, text = `T-${number}`) =>
    `[${text}](/projects/${id[slug]}/issues/${number})`;

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of [HERE, THERE, WALLED]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      id[slug] = ((await json(res)) as { id: number }).id;
    }
    outsider = await addUserWithToken(t.ctx, "anchored-outsider");
    const res = await req(`/projects/${HERE}/members/${outsider.user.id}`, {
      method: "PUT",
      body: JSON.stringify({ role: "writer" }),
    });
    expect(res.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("records a body's anchored link on a card in the same project", async () => {
    const target = await createIssue(HERE, "target");
    const text = `see ${anchored(HERE, target.number)}`;
    const source = await createIssue(HERE, "source", text);
    expect(source.body).toBe(text);
    const landed = await referenced(HERE, target.number);
    expect(landed).toHaveLength(1);
    expect(landed[0]?.payload).toMatchObject({
      by_project_id: id[HERE],
      by_issue: source.number,
    });
  });

  it("records a comment's anchored link, carrying the comment", async () => {
    const target = await createIssue(HERE, "comment target");
    const source = await createIssue(HERE, "commenter");
    const text = `also ${anchored(HERE, target.number)}`;
    const comment = await addComment(HERE, source.number, text);
    expect(comment.body).toBe(text);
    const landed = await referenced(HERE, target.number);
    expect(landed).toHaveLength(1);
    expect(landed[0]?.payload).toMatchObject({
      by_issue: source.number,
      by_comment: comment.id,
    });
  });

  it("records an anchored link added by an edit, once across re-saves", async () => {
    const target = await createIssue(HERE, "edit target");
    const source = await createIssue(HERE, "editable", "nothing yet");
    const text = `now ${anchored(HERE, target.number)}`;
    expect((await editBody(HERE, source.number, text)).body).toBe(text);
    expect((await editBody(HERE, source.number, `${text}!`)).body).toBe(
      `${text}!`,
    );
    expect(await referenced(HERE, target.number)).toHaveLength(1);
  });

  it("does not duplicate the event a typed #N already wrote", async () => {
    const target = await createIssue(HERE, "typed then copied");
    const source = await createIssue(HERE, "typed", `see #${target.number}`);
    // Saving back exactly what the read returned is the round trip every
    // editor does.
    await editBody(HERE, source.number, source.body);
    await addComment(HERE, source.number, `again ${source.body}`);
    expect(await referenced(HERE, target.number)).toHaveLength(1);
  });

  it("records a cross-project anchored link on the target's project", async () => {
    const target = await createIssue(THERE, "foreign target");
    const text = `see ${anchored(THERE, target.number, `${THERE}#${target.number}`)}`;
    const source = await createIssue(HERE, "foreign source", text);
    expect(source.body).toBe(text);
    const landed = await referenced(THERE, target.number);
    expect(landed).toHaveLength(1);
    expect(landed[0]?.payload).toMatchObject({
      by_project_id: id[HERE],
      by_issue: source.number,
    });
  });

  it("records a link anchored on a comment as a reference to its card", async () => {
    const target = await createIssue(THERE, "comment-anchored target");
    const comment = await addComment(THERE, target.number, "this one");
    const text = `see [there](/projects/${id[THERE]}/issues/${target.number}#comment-${comment.id})`;
    const source = await createIssue(HERE, "comment-anchored source", text);
    expect(source.body).toBe(text);
    expect(await referenced(THERE, target.number)).toHaveLength(1);
  });

  it("writes nothing when the author cannot read the target", async () => {
    const target = await createIssue(WALLED, "walled target");
    const text = `peek ${anchored(WALLED, target.number)}`;
    const source = await createIssue(HERE, "peeker", text, outsider.headers);
    expect(source.body).toBe(text);
    expect(await referenced(WALLED, target.number)).toHaveLength(0);
  });

  it("writes nothing on a card naming itself", async () => {
    const card = await createIssue(HERE, "narcissus");
    await editBody(HERE, card.number, `me ${anchored(HERE, card.number)}`);
    await addComment(HERE, card.number, `me ${anchored(HERE, card.number)}`);
    expect(await referenced(HERE, card.number)).toHaveLength(0);
  });

  it("writes nothing on a card in the trash", async () => {
    const target = await createIssue(HERE, "binned");
    const res = await req(`/projects/${HERE}/issues/${target.number}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    const text = `see ${anchored(HERE, target.number)}`;
    const source = await createIssue(HERE, "late", text);
    expect(source.body).toBe(text);
    expect(await referenced(HERE, target.number)).toHaveLength(0);
  });

  it("follows a moved card for the event and leaves the text alone", async () => {
    const card = await createIssue(HERE, "traveller");
    const moved = await req(`/projects/${HERE}/issues/${card.number}/move`, {
      method: "POST",
      body: JSON.stringify({ to_project: THERE }),
    });
    expect(moved.status).toBe(200);
    const to = ((await json(moved)) as { moved_to: { number: number } })
      .moved_to.number;
    const text = `see ${anchored(HERE, card.number)}`;
    const source = await createIssue(HERE, "after the move", text);
    expect(source.body).toBe(text);
    const landed = await referenced(THERE, to);
    expect(landed).toHaveLength(1);
    expect(landed[0]?.payload).toMatchObject({
      by_project_id: id[HERE],
      by_issue: source.number,
    });
  });

  it("leaves a link to a card that does not exist exactly as written", async () => {
    const text = `see ${anchored(HERE, 9999)}`;
    const source = await createIssue(HERE, "dangling", text);
    expect(source.body).toBe(text);
  });
});
