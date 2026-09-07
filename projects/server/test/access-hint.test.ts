import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("GET /api/me/access-hint (T-280)", () => {
  let t: TestApp;
  let cookie: string;
  const admin = () => ({ "content-type": "application/json", cookie });

  /** A machine user with no role in either project below. */
  let agent: { headers: { authorization: string }; id: number; login: string };

  const hint = (target: string) =>
    t.app.request(`/api/me/access-hint?target=${encodeURIComponent(target)}`, {
      headers: agent.headers,
    });

  async function createProject(slug: string, prefix: string): Promise<void> {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ slug, name: slug, ref_prefix: prefix }),
    });
    expect(res.status).toBe(201);
  }

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    await createProject("denied-to-me", "DTM");
    await createProject("just-unreadable", "JUN");

    const owner = await addUserWithToken(t.ctx, "hint-owner");
    const machine = await addUserWithToken(t.ctx, "hint-agent", {
      kind: "machine",
      ownerId: owner.user.id,
    });
    agent = {
      headers: machine.headers,
      id: machine.user.id,
      login: machine.user.login,
    };

    // One card, so the prefixed spelling has something to name.
    const opened = await t.app.request("/api/projects/denied-to-me/issues", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ title: "a card" }),
    });
    expect(opened.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("says nothing is suppressed before anyone denies anything", async () => {
    const res = await hint("denied-to-me");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      suppressed: false,
      login: agent.login,
      user_id: agent.id,
    });
  });

  it("answers a target that names no project at all with 200 and false", async () => {
    const res = await hint("no-such-project-anywhere");
    expect(res.status).toBe(200);
    expect((await json(res)).suppressed).toBe(false);
  });

  it("is field-for-field identical for an unreadable project and a missing one", async () => {
    // The whole disclosure argument rests on this: without a denial record,
    // the response cannot be used to learn that a project exists.
    const unreadable = await json(await hint("just-unreadable"));
    const missing = await json(await hint("no-such-project-anywhere"));
    expect(unreadable).toEqual(missing);
  });

  it("reports the denial under every spelling of the same project", async () => {
    const denied = await t.app.request(
      `/api/projects/denied-to-me/access-denials/${agent.id}`,
      { method: "PUT", headers: admin() },
    );
    expect(denied.status).toBe(204);

    const renamed = await t.app.request("/api/projects/denied-to-me", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ slug: "renamed-away" }),
    });
    expect(renamed.status).toBe(200);
    const projectId = (await json(renamed)).id as number;

    for (const target of [
      "renamed-away",
      // The retired slug and the prefix are the two spellings a CLI is most
      // likely to be holding, and both must find the record keyed by project.
      "denied-to-me",
      "renamed-away/1",
      "DTM-1",
      String(projectId),
    ]) {
      const body = await json(await hint(target));
      expect([target, body.suppressed]).toEqual([target, true]);
    }

    // Still nothing for the project nobody denied, spelled the same ways.
    expect((await json(await hint("just-unreadable"))).suppressed).toBe(false);
    expect((await json(await hint("JUN-1"))).suppressed).toBe(false);
  });
});
