import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const P = "users-a";
const Q = "users-b";

describe("GET /api/users/{ref} T-373", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  let stranger: Awaited<ReturnType<typeof addUserWithToken>>;
  let admin: Awaited<ReturnType<typeof addUserWithToken>>;
  let owner: Awaited<ReturnType<typeof addUserWithToken>>;
  let ownedAgent: Awaited<ReturnType<typeof addUserWithToken>>;
  let siblingAgent: Awaited<ReturnType<typeof addUserWithToken>>;
  let strangerAgent: Awaited<ReturnType<typeof addUserWithToken>>;
  let ownedHuman: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const [slug, name] of [
      [P, "Users A"],
      [Q, "Users B"],
    ] as const) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name }),
      });
      expect(res.status).toBe(201);
    }
    bob = await addUserWithToken(t.ctx, "route-bob");
    stranger = await addUserWithToken(t.ctx, "route-stranger");
    admin = await addUserWithToken(t.ctx, "route-admin", {
      instanceAdmin: true,
    });
    // bob shares project P with the caller (the logged-in admin user).
    const member = await t.app.request(
      `/api/projects/${P}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);

    // A fresh non-admin account, never the cookie user above: that one is the
    // deployment's first human and therefore an instance admin, which would
    // answer every ownership case below on its own.
    owner = await addUserWithToken(t.ctx, "route-owner");
    ownedAgent = await addUserWithToken(t.ctx, "route-agent", {
      kind: "machine",
      ownerId: owner.user.id,
    });
    siblingAgent = await addUserWithToken(t.ctx, "route-agent-sibling", {
      kind: "machine",
      ownerId: owner.user.id,
    });
    strangerAgent = await addUserWithToken(t.ctx, "route-agent-elsewhere", {
      kind: "machine",
      ownerId: stranger.user.id,
    });
    ownedHuman = await addUserWithToken(t.ctx, "route-owned-human", {
      ownerId: owner.user.id,
    });
    // A seat for the owner alone, so `/issues` reaches the merge instead of
    // returning early on an empty scope. None of the agents get one, which is
    // what leaves the ownership exemption as the only way to a 200.
    const ownerSeat = await t.app.request(
      `/api/projects/${P}/members/${owner.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(ownerSeat.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("answers by id and by login", async () => {
    const byId = await t.app.request(`/api/users/${bob.user.id}`, {
      headers: headers(),
    });
    expect(byId.status).toBe(200);
    const idBody = await json(byId);
    expect(idBody.login).toBe("route-bob");
    expect(idBody.id).toBe(bob.user.id);
    expect(idBody.created_at).toBeTruthy();

    const byLogin = await t.app.request("/api/users/route-bob", {
      headers: headers(),
    });
    expect(byLogin.status).toBe(200);
    expect((await json(byLogin)).id).toBe(bob.user.id);
  });

  it("404s identically for a stranger and a nonexistent login", async () => {
    // bob is a plain member of P only: stranger shares nothing with him, so
    // "cannot see" must answer exactly like "does not exist".
    const strangerRes = await t.app.request(`/api/users/${stranger.user.id}`, {
      headers: { ...bob.headers },
    });
    expect(strangerRes.status).toBe(404);
    const strangerBody = await json(strangerRes);

    const ghostRes = await t.app.request("/api/users/never-existed", {
      headers: { ...bob.headers },
    });
    expect(ghostRes.status).toBe(404);
    expect(await json(ghostRes)).toEqual(strangerBody);
  });

  it("answers for a shared-project account, by login", async () => {
    const res = await t.app.request("/api/users/route-bob", {
      headers: { ...bob.headers },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe(bob.user.id);
  });

  it("carries no email and no is_instance_admin", async () => {
    const res = await t.app.request(`/api/users/${bob.user.id}`, {
      headers: headers(),
    });
    const body = await json(res);
    expect("email" in body).toBe(false);
    expect("is_instance_admin" in body).toBe(false);
  });

  it("an instance admin sees a non-shared account", async () => {
    const res = await t.app.request(`/api/users/${stranger.user.id}`, {
      headers: { ...admin.headers },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).login).toBe("route-stranger");
  });

  it("always answers for the caller themself", async () => {
    const res = await t.app.request(`/api/users/${stranger.user.id}`, {
      headers: { ...stranger.headers },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).login).toBe("route-stranger");
  });

  it("answers for a machine account the caller owns T-410", async () => {
    const res = await t.app.request("/api/users/route-agent", {
      headers: { ...owner.headers },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe(ownedAgent.user.id);
  });

  it("resolves the owned agent for the subresources too T-410", async () => {
    // The empty project list is the load-bearing half: it says this agent
    // holds no seat anywhere, so the 200s here and above cannot be the
    // shared-project branch answering.
    const projectsRes = await t.app.request("/api/users/route-agent/projects", {
      headers: { ...owner.headers },
    });
    expect(projectsRes.status).toBe(200);
    expect((await json(projectsRes)).items).toEqual([]);

    const issuesRes = await t.app.request("/api/users/route-agent/issues", {
      headers: { ...owner.headers },
    });
    expect(issuesRes.status).toBe(200);
    expect((await json(issuesRes)).items).toEqual([]);
  });

  it("404s for a machine account somebody else owns T-410", async () => {
    // Without this the 404 below would also pass on an agent whose `ownerId`
    // never got written, and the rule could be as wide as "any owned account".
    expect(strangerAgent.user.ownerId).toBe(stranger.user.id);

    const res = await t.app.request("/api/users/route-agent-elsewhere", {
      headers: { ...owner.headers },
    });
    expect(res.status).toBe(404);

    const ghost = await t.app.request("/api/users/never-existed", {
      headers: { ...owner.headers },
    });
    expect(ghost.status).toBe(404);
    expect(await json(res)).toEqual(await json(ghost));
  });

  it("404s between two agents of one owner T-410", async () => {
    const res = await t.app.request("/api/users/route-agent", {
      headers: { ...siblingAgent.headers },
    });
    expect(res.status).toBe(404);
  });

  it("404s for the owner when their own agent asks T-410", async () => {
    const res = await t.app.request("/api/users/route-owner", {
      headers: { ...ownedAgent.headers },
    });
    expect(res.status).toBe(404);
  });

  it("404s for a human account carrying an owner_id T-410", async () => {
    // A state no product path builds: `owner_id` is written by `createAgent`
    // alone, always alongside `kind: "machine"`. The case exists to keep the
    // `kind` guard from being read as dead code and dropped.
    expect(ownedHuman.user.kind).toBe("human");
    expect(ownedHuman.user.ownerId).toBe(owner.user.id);

    const res = await t.app.request("/api/users/route-owned-human", {
      headers: { ...owner.headers },
    });
    expect(res.status).toBe(404);
  });
});
