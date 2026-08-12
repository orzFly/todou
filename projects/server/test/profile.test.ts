import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_SUBJECT, ensureBuiltinUser } from "../src/bootstrap.ts";
import { users } from "../src/db/system-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

function avatarForm(
  content: Uint8Array<ArrayBuffer> | string = PNG_BYTES,
  type = "image/png",
): FormData {
  const form = new FormData();
  form.set("file", new File([content], "avatar.png", { type }));
  return form;
}

describe("profile editing", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });
  const patchMe = (
    body: Record<string, unknown>,
    extra?: Record<string, string>,
  ) =>
    t.app.request("/api/me", {
      method: "PATCH",
      headers: extra ?? headers(),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("changes my display name", async () => {
    const res = await patchMe({ display_name: "Potato Farmer" });
    expect(res.status).toBe(200);
    expect((await json(res)).display_name).toBe("Potato Farmer");

    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    expect(me.display_name).toBe("Potato Farmer");
  });

  it("rejects logins that break the format", async () => {
    for (const login of ["UPPER", "-lead", "sp ace", ""]) {
      const res = await patchMe({ login });
      expect(res.status).toBe(422);
    }
  });

  it("rejects reserved logins", async () => {
    for (const login of ["me", "ghost"]) {
      const res = await patchMe({ login });
      expect(res.status).toBe(422);
    }
  });

  it("409s when the login is already taken", async () => {
    await addUserWithToken(t.ctx, "taken-login");
    const res = await patchMe({ login: "taken-login" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("conflict");
  });

  it("allows re-submitting my current login (no-op)", async () => {
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    const res = await patchMe({ login: me.login });
    expect(res.status).toBe(200);
  });

  it("renames my login; sessions and single-mode login survive", async () => {
    const res = await patchMe({ login: "spudmaster" });
    expect(res.status).toBe(200);
    expect((await json(res)).login).toBe("spudmaster");

    // The session cookie keys on user id, so it keeps working mid-rename.
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    expect(me.login).toBe("spudmaster");

    // The built-in account is tracked by subject, not login: a fresh
    // single-mode login must find the renamed user...
    const relogin = await t.app.request("/api/auth/login", { method: "POST" });
    expect(relogin.status).toBe(200);
    expect((await json(relogin)).login).toBe("spudmaster");

    // ...and a rebooted server must not seed a duplicate "user" account.
    await ensureBuiltinUser(t.ctx.router.system());
    const rows = await t.ctx.router
      .system()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.oidcSubject, BUILTIN_SUBJECT));
    expect(rows.length).toBe(1);
  });

  it("machine users may rename their display name but not their login", async () => {
    const agent = await addUserWithToken(t.ctx, "profile-bot", {
      kind: "machine",
      ownerId: 1,
    });
    const nameRes = await patchMe(
      { display_name: "Profile Bot 2000" },
      { "content-type": "application/json", ...agent.headers },
    );
    expect(nameRes.status).toBe(200);

    const loginRes = await patchMe(
      { login: "sneaky-bot" },
      { "content-type": "application/json", ...agent.headers },
    );
    expect(loginRes.status).toBe(403);
  });
});

describe("avatars", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const uploadMine = (form: FormData) =>
    t.app.request("/api/me/avatar", {
      method: "POST",
      headers: { cookie },
      body: form,
    });

  it("uploads, serves, and replaces my avatar", async () => {
    const res = await uploadMine(avatarForm());
    expect(res.status).toBe(200);
    const me = await json(res);
    expect(me.avatar_url).toContain(`/api/users/${me.id}/avatar?v=`);

    const img = await t.app.request(me.avatar_url, { headers: { cookie } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG_BYTES);

    // Replacing rotates the storage key, so the URL version changes.
    const replaced = await json(await uploadMine(avatarForm()));
    expect(replaced.avatar_url).not.toBe(me.avatar_url);
  });

  it("embeds avatar_url in user refs everywhere", async () => {
    await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "ava", name: "Ava" }),
    });
    const issueRes = await t.app.request("/api/projects/ava/issues", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "avatar propagation" }),
    });
    const issue = await json(issueRes);
    expect(issue.author.avatar_url).toContain("/api/users/");

    const members = await json(
      await t.app.request("/api/projects/ava/members", { headers: { cookie } }),
    );
    expect(members[0].user.avatar_url).toContain("/api/users/");
  });

  it("rejects non-image and oversized uploads", async () => {
    const badType = await uploadMine(avatarForm("text", "text/plain"));
    expect(badType.status).toBe(422);

    const oversized = await uploadMine(
      avatarForm(new Uint8Array(2 * 1024 * 1024 + 1)),
    );
    expect(oversized.status).toBe(422);
  });

  it("removes my avatar and 404s the image afterwards", async () => {
    const me = await json(await uploadMine(avatarForm()));
    const removed = await json(
      await t.app.request("/api/me/avatar", {
        method: "DELETE",
        headers: { cookie },
      }),
    );
    expect(removed.avatar_url).toBeNull();

    const img = await t.app.request(me.avatar_url, { headers: { cookie } });
    expect(img.status).toBe(404);
  });

  it("404s for users who never uploaded one", async () => {
    const other = await addUserWithToken(t.ctx, "no-avatar");
    const res = await t.app.request(`/api/users/${other.user.id}/avatar`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});

describe("agent profile management (owner)", () => {
  let t: TestApp;
  let cookie: string;
  let agentId: number;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const created = await json(
      await t.app.request("/api/agents", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ login: "till-bot", display_name: "Till Bot" }),
      }),
    );
    agentId = created.id;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("renames an agent's login", async () => {
    const res = await t.app.request(`/api/agents/${agentId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ login: "harvest-bot" }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).login).toBe("harvest-bot");
  });

  it("409s on a login collision", async () => {
    await addUserWithToken(t.ctx, "occupied");
    const res = await t.app.request(`/api/agents/${agentId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ login: "occupied" }),
    });
    expect(res.status).toBe(409);
  });

  it("manages the agent's avatar", async () => {
    const form = avatarForm();
    const res = await t.app.request(`/api/agents/${agentId}/avatar`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(200);
    const agent = await json(res);
    expect(agent.avatar_url).toContain(`/api/users/${agentId}/avatar?v=`);

    const removed = await json(
      await t.app.request(`/api/agents/${agentId}/avatar`, {
        method: "DELETE",
        headers: { cookie },
      }),
    );
    expect(removed.avatar_url).toBeNull();
  });

  it("403s for non-owners", async () => {
    const stranger = await addUserWithToken(t.ctx, "stranger");
    const rename = await t.app.request(`/api/agents/${agentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...stranger.headers },
      body: JSON.stringify({ login: "hijacked" }),
    });
    expect(rename.status).toBe(403);

    const avatar = await t.app.request(`/api/agents/${agentId}/avatar`, {
      method: "POST",
      headers: stranger.headers,
      body: avatarForm(),
    });
    expect(avatar.status).toBe(403);
  });
});
