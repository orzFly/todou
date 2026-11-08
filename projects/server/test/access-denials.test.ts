import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectAccessDenials } from "../src/db/system-schema.ts";
import { getProjectByRef } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * One placement: denials live in the system tier, which no placement mode
 * moves.
 */
describe("access denials (T-280)", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "denials";
  const admin = () => ({ "content-type": "application/json", cookie });

  let reader: { headers: { authorization: string }; id: number };
  let stranger: { headers: { authorization: string }; id: number };
  let agent: number;
  let human: number;

  const denialUrl = (userId: number) =>
    `/api/projects/${slug}/access-denials/${userId}`;

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ slug, name: "Denials", ref_prefix: "DEN" }),
    });
    expect(created.status).toBe(201);

    const readerUser = await addUserWithToken(t.ctx, "reader-of-denials");
    reader = { headers: readerUser.headers, id: readerUser.user.id };
    const added = await t.app.request(
      `/api/projects/${slug}/members/${reader.id}`,
      {
        method: "PUT",
        headers: admin(),
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(added.status).toBe(204);

    const outsider = await addUserWithToken(t.ctx, "stranger-to-denials");
    stranger = { headers: outsider.headers, id: outsider.user.id };

    const machine = await addUserWithToken(t.ctx, "denied-agent", {
      kind: "machine",
      ownerId: outsider.user.id,
    });
    agent = machine.user.id;
    // What the CLI does before printing the link a reader would follow.
    const asked = await t.app.request(`/api/me/access-hint?target=${slug}`, {
      headers: machine.headers,
    });
    expect(asked.status).toBe(200);

    human = (await addUserWithToken(t.ctx, "some-human")).user.id;
    const joined = await t.app.request(
      `/api/projects/${slug}/members/${human}`,
      {
        method: "PUT",
        headers: admin(),
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(joined.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("lets a reader deny and undo, and lists what was recorded", async () => {
    const denied = await t.app.request(denialUrl(agent), {
      method: "PUT",
      headers: reader.headers,
    });
    expect(denied.status).toBe(204);

    const list = await t.app.request(`/api/projects/${slug}/access-denials`, {
      headers: reader.headers,
    });
    expect(list.status).toBe(200);
    const rows = await json(list);
    expect(rows).toHaveLength(1);
    expect(rows[0].user.id).toBe(agent);
    expect(rows[0].denied_by.id).toBe(reader.id);

    const undone = await t.app.request(denialUrl(agent), {
      method: "DELETE",
      headers: reader.headers,
    });
    expect(undone.status).toBe(204);
    expect(
      await json(
        await t.app.request(`/api/projects/${slug}/access-denials`, {
          headers: reader.headers,
        }),
      ),
    ).toEqual([]);
  });

  it("repeats idempotently, recording the latest denier", async () => {
    for (const who of [reader.headers, admin()]) {
      const res = await t.app.request(denialUrl(agent), {
        method: "PUT",
        headers: who,
      });
      expect(res.status).toBe(204);
    }
    const rows = await json(
      await t.app.request(`/api/projects/${slug}/access-denials`, {
        headers: reader.headers,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].denied_by.id).not.toBe(reader.id);
  });

  it("answers a non-member with 404, never 403", async () => {
    for (const [method, url] of [
      ["GET", `/api/projects/${slug}/access-denials`],
      ["PUT", denialUrl(agent)],
      ["DELETE", denialUrl(agent)],
    ] as const) {
      const res = await t.app.request(url, {
        method,
        headers: stranger.headers,
      });
      // 403 would confirm the project exists to somebody with no role in it,
      // which is the whole point of the 404 in requireProject.
      expect([method, res.status]).toEqual([method, 404]);
      expect((await json(res)).error.message).toBe("project not found");
    }
  });

  it("refuses a human target with 422 and an unknown one with 404", async () => {
    const person = await t.app.request(denialUrl(human), {
      method: "PUT",
      headers: reader.headers,
    });
    expect(person.status).toBe(422);

    const nobody = await t.app.request(denialUrl(999_999), {
      method: "PUT",
      headers: reader.headers,
    });
    expect(nobody.status).toBe(404);
    expect((await json(nobody)).error.message).toBe("user not found");
  });

  it("404s a delete with nothing to delete", async () => {
    const res = await t.app.request(denialUrl(human), {
      method: "DELETE",
      headers: reader.headers,
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toBe("denial not found");
  });
});

/**
 * The new table on a real server, migration included. PGlite's clock only
 * produces milliseconds while postgres stores microseconds, so a timestamp
 * column is exactly the kind of thing the in-memory suite is blind to (T-77).
 * Runs only when TODOU_TEST_POSTGRES_URL points at a live server, e.g.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test access-denials
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("access denials on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  let agentId: number;
  // The database persists across runs; a unique slug isolates each one.
  const slug = `denials-pg-${Date.now().toString(36)}`;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Denials (postgres)" }),
    });
    expect(created.status).toBe(201);
    const owner = await addUserWithToken(t.ctx, `owner-${slug}`);
    const agent = await addUserWithToken(t.ctx, `agent-${slug}`, {
      kind: "machine",
      ownerId: owner.user.id,
    });
    agentId = agent.user.id;
    // The new table's write path rides on the same real server (T-657).
    const asked = await t.app.request(`/api/me/access-hint?target=${slug}`, {
      headers: agent.headers,
    });
    expect(asked.status).toBe(200);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("records, reports and undoes one, with a readable timestamp", async () => {
    const before = Date.now();
    const denied = await t.app.request(
      `/api/projects/${slug}/access-denials/${agentId}`,
      { method: "PUT", headers: headers() },
    );
    expect(denied.status).toBe(204);

    const rows = await json(
      await t.app.request(`/api/projects/${slug}/access-denials`, {
        headers: headers(),
      }),
    );
    expect(rows).toHaveLength(1);
    // Microsecond storage still has to round-trip as a parseable instant.
    const stamp = Date.parse(rows[0].created_at);
    expect(Number.isNaN(stamp)).toBe(false);
    expect(stamp).toBeGreaterThanOrEqual(before - 1000);

    const hint = await json(
      await t.app.request(`/api/me/access-hint?target=${slug}`, {
        headers: headers(),
      }),
    );
    // The caller here is the project's admin, not the denied agent.
    expect(hint.suppressed).toBe(false);

    const undone = await t.app.request(
      `/api/projects/${slug}/access-denials/${agentId}`,
      { method: "DELETE", headers: headers() },
    );
    expect(undone.status).toBe(204);
  });
});

/**
 * A denial target is an agent with some tie to this project (T-657): its
 * owner is a member, or it asked for access here. Anyone else is the
 * same 404 as an id nobody holds, or `PUT` turns into an oracle for which
 * accounts exist and which are agents, and the list reads out their logins
 * and owners to someone who could not otherwise see them.
 */
describe("access denials only name agents tied to the project", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "own-probe";
  type Caller = Awaited<ReturnType<typeof addUserWithToken>>;
  let eve: Caller;
  let hiddenOwner: Caller;
  let hiddenAgent: Caller;
  let asker: Caller;
  let memberOwnersAgent: Caller;
  let memberHuman: Caller;

  const put = (userId: number) =>
    t.app.request(`/api/projects/${slug}/access-denials/${userId}`, {
      method: "PUT",
      headers: eve.headers,
    });
  const list = async () => {
    const res = await t.app.request(`/api/projects/${slug}/access-denials`, {
      headers: eve.headers,
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  async function addMember(userId: number, role: string) {
    const res = await t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role }),
    });
    expect(res.status).toBe(204);
  }

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    eve = await addUserWithToken(t.ctx, "eve");
    // Anyone signed in may open a project of their own, which is what makes
    // this reachable for every account on the instance.
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: { ...eve.headers, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: "Probe" }),
    });
    expect(created.status).toBe(201);

    hiddenOwner = await addUserWithToken(t.ctx, "hidden-owner");
    hiddenAgent = await addUserWithToken(t.ctx, "hidden-agent", {
      kind: "machine",
      ownerId: hiddenOwner.user.id,
    });
    const askerOwner = await addUserWithToken(t.ctx, "asker-owner");
    asker = await addUserWithToken(t.ctx, "asker-agent", {
      kind: "machine",
      ownerId: askerOwner.user.id,
    });
    const memberOwner = await addUserWithToken(t.ctx, "member-owner");
    await addMember(memberOwner.user.id, "reader");
    memberOwnersAgent = await addUserWithToken(t.ctx, "member-owners-agent", {
      kind: "machine",
      ownerId: memberOwner.user.id,
    });
    memberHuman = await addUserWithToken(t.ctx, "member-human");
    await addMember(memberHuman.user.id, "reader");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("answers an unrelated agent, an unrelated human and a missing id alike", async () => {
    const answers = [];
    for (const id of [hiddenAgent.user.id, hiddenOwner.user.id, 999_999]) {
      const res = await put(id);
      const text = await res.text();
      answers.push({ status: res.status, body: text && JSON.parse(text) });
    }
    expect(answers[0]).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "user not found" } },
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it("leaves a recorded denial of an unrelated agent out of the list", async () => {
    const project = await getProjectByRef(t.ctx, slug);
    // A row from before the gate existed, which no request can make now.
    await t.ctx.router
      .system()
      .insert(projectAccessDenials)
      .values({
        projectId: project.id,
        userId: hiddenAgent.user.id,
        deniedBy: eve.user.id,
      })
      .onConflictDoNothing();
    expect(JSON.stringify(await list())).not.toContain("hidden-");
  });

  it("still takes an agent from outside that asked for access here", async () => {
    const hint = await t.app.request(
      `/api/me/access-hint?target=${encodeURIComponent(slug)}`,
      { headers: asker.headers },
    );
    expect(hint.status).toBe(200);
    expect((await put(asker.user.id)).status).toBe(204);
    const row = (await list()).find(
      (r: { user: { id: number } }) => r.user.id === asker.user.id,
    );
    expect(row.user.login).toBe("asker-agent");
    expect(row.user.owner.login).toBe("asker-owner");
  });

  it("still takes an agent whose owner is a member, unasked", async () => {
    expect((await put(memberOwnersAgent.user.id)).status).toBe(204);
    const ids = (await list()).map((r: { user: { id: number } }) => r.user.id);
    expect(ids).toContain(memberOwnersAgent.user.id);
  });

  it("still tells a member who is a person why they cannot be denied", async () => {
    expect((await put(memberHuman.user.id)).status).toBe(422);
  });
});
