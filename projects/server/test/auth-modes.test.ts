import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** A request that reaches the app through the (fake) node socket. */
const fromPeer = (remoteAddress: string) => ({
  incoming: { socket: { remoteAddress } },
});

const FORWARD_TOML = [
  "[auth]",
  'mode = "forward"',
  "[auth.forward]",
  'user_header = "Remote-User"',
  'name_header = "Remote-Name"',
  'email_header = "Remote-Email"',
].join("\n");

describe("GET /api/auth/mode", () => {
  it("reports the configured mode publicly", async () => {
    const single = await makeTestApp();
    try {
      const res = await single.app.request("/api/auth/mode");
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ mode: "single" });
    } finally {
      await single.cleanup();
    }

    const forward = await makeTestApp("shared", { extraToml: FORWARD_TOML });
    try {
      const res = await forward.app.request("/api/auth/mode");
      expect(await json(res)).toEqual({ mode: "forward" });
    } finally {
      await forward.cleanup();
    }
  });
});

describe("forward mode", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp("shared", { extraToml: FORWARD_TOML });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const me = (env: unknown, headers: Record<string, string> = {}) =>
    t.app.request("/api/me", { headers }, env);

  it("401s when the peer is not a trusted proxy", async () => {
    const res = await me(fromPeer("10.9.9.9"), { "Remote-User": "alice" });
    expect(res.status).toBe(401);
    expect((await json(res)).error.message).toContain("trusted proxy");
  });

  it("401s when there is no peer address at all", async () => {
    const res = await me({}, { "Remote-User": "alice" });
    expect(res.status).toBe(401);
  });

  it("401s when the identity header is missing, distinguishably", async () => {
    const res = await me(fromPeer("127.0.0.1"));
    expect(res.status).toBe(401);
    expect((await json(res)).error.message).toContain("Remote-User");
  });

  it("401s on an unusable login value", async () => {
    const res = await me(fromPeer("127.0.0.1"), {
      "Remote-User": "John Doe!",
    });
    expect(res.status).toBe(401);
    expect((await json(res)).error.message).toContain("invalid login");
  });

  it("JIT-creates from the headers; first human becomes admin", async () => {
    const res = await me(fromPeer("127.0.0.1"), {
      "Remote-User": "Alice",
      "Remote-Name": "Alice Weber",
      "Remote-Email": "alice@example.com",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.login).toBe("alice");
    expect(body.display_name).toBe("Alice Weber");
    expect(body.email).toBe("alice@example.com");
    expect(body.is_instance_admin).toBe(true);

    const second = await me(fromPeer("127.0.0.1"), { "Remote-User": "bob" });
    expect((await json(second)).is_instance_admin).toBe(false);
  });

  it("sets no cookie: authentication is per request", async () => {
    const res = await me(fromPeer("127.0.0.1"), { "Remote-User": "alice" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("lets Bearer PATs bypass the identity header entirely", async () => {
    // Mint a PAT for alice through the API itself (she exists by now).
    const minted = await t.app.request(
      "/api/me/tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Remote-User": "alice",
        },
        body: JSON.stringify({ name: "cli" }),
      },
      fromPeer("127.0.0.1"),
    );
    expect(minted.status).toBe(201);
    const { token } = await json(minted);

    // No trusted peer, no header — the PAT alone authenticates.
    const res = await me({}, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect((await json(res)).login).toBe("alice");

    // And an invalid PAT stays a hard 401 even with a valid header.
    const bad = await me(fromPeer("127.0.0.1"), {
      authorization: "Bearer todou_pat_bogus",
      "Remote-User": "alice",
    });
    expect(bad.status).toBe(401);
  });

  it("400s the single-mode login endpoint and 204s logout", async () => {
    const login = await t.app.request("/api/auth/login", { method: "POST" });
    expect(login.status).toBe(400);
    expect((await json(login)).error.code).toBe("wrong_auth_mode");

    const logout = await t.app.request("/api/auth/logout", {
      method: "POST",
    });
    expect(logout.status).toBe(204);
  });
});

describe("session cookie Secure attribute", () => {
  const login = (t: TestApp, env: unknown, headers: Record<string, string> = {}) =>
    t.app.request("/api/auth/login", { method: "POST", headers }, env);

  it("auto mode: Secure only when a trusted proxy says https", async () => {
    const t = await makeTestApp();
    try {
      const plain = await login(t, fromPeer("127.0.0.1"));
      expect(plain.headers.get("set-cookie")).not.toContain("Secure");

      const proxied = await login(t, fromPeer("127.0.0.1"), {
        "X-Forwarded-Proto": "https",
      });
      expect(proxied.headers.get("set-cookie")).toContain("Secure");

      const spoofed = await login(t, fromPeer("10.9.9.9"), {
        "X-Forwarded-Proto": "https",
      });
      expect(spoofed.headers.get("set-cookie")).not.toContain("Secure");
    } finally {
      await t.cleanup();
    }
  });

  it("an explicit cookie_secure overrides the auto detection", async () => {
    const on = await makeTestApp("shared", {
      extraToml: "[auth]\ncookie_secure = true",
    });
    try {
      const res = await login(on, fromPeer("127.0.0.1"));
      expect(res.headers.get("set-cookie")).toContain("Secure");
    } finally {
      await on.cleanup();
    }

    const off = await makeTestApp("shared", {
      extraToml: "[auth]\ncookie_secure = false",
    });
    try {
      const res = await login(off, fromPeer("127.0.0.1"), {
        "X-Forwarded-Proto": "https",
      });
      expect(res.headers.get("set-cookie")).not.toContain("Secure");
    } finally {
      await off.cleanup();
    }
  });
});
