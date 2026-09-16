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
});
