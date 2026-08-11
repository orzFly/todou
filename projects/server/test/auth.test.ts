import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAT_PREFIX } from "../src/auth/pat.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

let t: TestApp;

beforeAll(async () => {
  t = await makeTestApp();
});

afterAll(async () => {
  await t.cleanup();
});

async function issueToken(
  cookie: string,
  body: Record<string, unknown> = { name: "test-token" },
) {
  const res = await t.app.request("/api/me/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  return res;
}

describe("single-mode login", () => {
  it("creates a session for the built-in user without credentials", async () => {
    const res = await t.app.request("/api/auth/login", { method: "POST" });
    expect(res.status).toBe(200);
    const me = await json(res);
    expect(me.login).toBe("user");
    expect(me.kind).toBe("human");
    expect(me.is_instance_admin).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("todou_session=");
  });

  it("serves /me with the session cookie", async () => {
    const cookie = await t.login();
    const res = await t.app.request("/api/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await json(res)).login).toBe("user");
  });

  it("rejects requests with no credentials", async () => {
    const res = await t.app.request("/api/me");
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("unauthorized");
  });

  it("invalidates the session on logout", async () => {
    const cookie = await t.login();
    const out = await t.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(out.status).toBe(204);
    const res = await t.app.request("/api/me", { headers: { cookie } });
    expect(res.status).toBe(401);
  });
});

describe("personal access tokens", () => {
  it("issues a token whose plaintext works as a bearer credential", async () => {
    const cookie = await t.login();
    const created = await json(await issueToken(cookie));
    expect(created.token.startsWith(PAT_PREFIX)).toBe(true);

    const res = await t.app.request("/api/me", {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).login).toBe("user");
  });

  it("lists tokens with prefixes only, never plaintext", async () => {
    const cookie = await t.login();
    const created = await json(await issueToken(cookie, { name: "listed" }));
    const res = await t.app.request("/api/me/tokens", { headers: { cookie } });
    const items = await json(res);
    const listed = items.find((i: { name: string }) => i.name === "listed");
    expect(listed.prefix.length).toBeLessThan(created.token.length);
    expect(JSON.stringify(items)).not.toContain(created.token);
  });

  it("hard-rejects invalid bearer tokens without cookie fallback", async () => {
    const cookie = await t.login();
    const res = await t.app.request("/api/me", {
      headers: { authorization: "Bearer todou_pat_bogus", cookie },
    });
    expect(res.status).toBe(401);
  });

  it("rejects malformed authorization headers", async () => {
    const res = await t.app.request("/api/me", {
      headers: { authorization: "Basic dXNlcjo=" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects revoked tokens", async () => {
    const cookie = await t.login();
    const created = await json(await issueToken(cookie, { name: "doomed" }));
    const del = await t.app.request(`/api/me/tokens/${created.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(204);
    const res = await t.app.request("/api/me", {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const cookie = await t.login();
    const created = await json(
      await issueToken(cookie, {
        name: "expired",
        expires_at: "2020-01-01T00:00:00Z",
      }),
    );
    const res = await t.app.request("/api/me", {
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(res.status).toBe(401);
  });

  it("422s on invalid token payloads", async () => {
    const cookie = await t.login();
    const res = await issueToken(cookie, { name: "" });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("validation_failed");
  });

  it("404s when revoking someone else's / unknown token", async () => {
    const cookie = await t.login();
    const res = await t.app.request("/api/me/tokens/99999", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
