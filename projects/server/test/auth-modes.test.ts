import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { users } from "../src/db/system-schema.ts";
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
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await me(fromPeer("10.9.9.9"), { "Remote-User": "alice" });
      expect(res.status).toBe(401);
      // Read the raw body once: json() would leave it unusable for a
      // second read, and a property-style res.text is a function object —
      // a negative matcher against it passes vacuously.
      const raw = await res.text();
      const parsed: unknown = JSON.parse(raw);
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "message" in parsed.error &&
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : "";
      // Points at the knob, never leaks the observed address (T-333: the
      // peer address may belong to another reverse proxy). The not-contains
      // on `raw` covers the whole body — message, details, every field.
      expect(message).toContain("http.trusted_proxies");
      expect(raw).not.toContain("10.9.9.9");
      // The address landed in the log — otherwise the not-in-body
      // assertions above would be vacuously true.
      const logged = errSpy.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.includes("10.9.9.9"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("http.trusted_proxies");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("401s when there is no peer address at all", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await me({}, { "Remote-User": "alice" });
      expect(res.status).toBe(401);
      const noPeerMessage = (await json(res)).error.message as string;
      // No peer is not a configuration problem: pointing at
      // trusted_proxies here sent three debugging rounds the wrong way.
      expect(noPeerMessage).not.toContain("trusted_proxies");
      expect(noPeerMessage).toContain("nothing in the configuration");

      const listed = await me(fromPeer("10.9.9.9"), {
        "Remote-User": "alice",
      });
      const notListedMessage = (await json(listed)).error.message as string;
      expect(noPeerMessage).not.toBe(notListedMessage);

      const logged = errSpy.mock.calls.map((args) => args.join(" "));
      expect(
        logged.filter((line) => line.includes("no peer address")),
      ).toHaveLength(1);
      expect(
        logged.find((line) => line.includes("no peer address")),
      ).not.toContain("http.trusted_proxies");
    } finally {
      errSpy.mockRestore();
    }
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

  it("suffixes past a taken login instead of adopting the account", async () => {
    const db = t.ctx.router.system();
    const rows = await db
      .insert(users)
      .values({ kind: "human", login: "squatted", displayName: "squatted" })
      .returning();
    const victim = rows[0];
    if (!victim) throw new Error("insert returned no row");

    const res = await me(fromPeer("127.0.0.1"), { "Remote-User": "squatted" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).not.toBe(victim.id);
    expect(body.login).toMatch(/^squatted-[a-z0-9]{4}$/);

    const after = await db.select().from(users).where(eq(users.id, victim.id));
    expect(after[0]).toEqual(victim);
  });

  it("keeps the identity when the login is renamed inside todou", async () => {
    const db = t.ctx.router.system();
    const first = await me(fromPeer("127.0.0.1"), { "Remote-User": "renny" });
    const created = await json(first);

    await db
      .update(users)
      .set({ login: "renny-renamed" })
      .where(eq(users.id, created.id));

    const second = await me(fromPeer("127.0.0.1"), { "Remote-User": "renny" });
    const body = await json(second);
    expect(body.id).toBe(created.id);
    expect(body.login).toBe("renny-renamed");
  });

  it("sets no cookie: authentication is per request", async () => {
    const res = await me(fromPeer("127.0.0.1"), { "Remote-User": "alice" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("logs nothing on a trusted peer (rejection logs fire on rejection only)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await me(fromPeer("127.0.0.1"), { "Remote-User": "alice" });
      expect(res.status).toBe(200);
      expect(
        errSpy.mock.calls
          .map((args) => args.join(" "))
          .filter((line) => line.includes("forward auth: rejected")),
      ).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
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

  it("authenticates batched sub-requests like any other request", async () => {
    const res = await t.app.request(
      "/api/batch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Remote-User": "alice",
        },
        body: JSON.stringify({
          requests: [{ url: "/auth/mode" }, { url: "/me" }],
        }),
      },
      fromPeer("127.0.0.1"),
    );
    expect(res.status).toBe(200);
    const { responses } = await json(res);
    expect(responses[0]).toEqual({ status: 200, body: { mode: "forward" } });
    expect(responses[1].status).toBe(200);
    expect(responses[1].body.login).toBe("alice");
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
  const login = (
    t: TestApp,
    env: unknown,
    headers: Record<string, string> = {},
  ) => t.app.request("/api/auth/login", { method: "POST", headers }, env);

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

describe("proxy header trace on the login endpoint", () => {
  const login = (
    t: TestApp,
    env: unknown,
    headers: Record<string, string> = {},
  ) => t.app.request("/api/auth/login", { method: "POST", headers }, env);

  it("traces ignored forwarded headers with the peer that sent them", async () => {
    // 证伪: deleting the middleware → red. Trace and cookie in one case
    // bind "the line exists" to "this is who it is for".
    const t = await makeTestApp();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await login(t, fromPeer("10.9.9.9"), {
        "X-Forwarded-Proto": "https",
      });
      const logged = errSpy.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.includes("proxy headers ignored"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("x-forwarded-proto");
      expect(logged[0]).toContain("10.9.9.9");
      expect(res.headers.get("set-cookie")).not.toContain("Secure");
    } finally {
      errSpy.mockRestore();
      await t.cleanup();
    }
  });

  it("traces nothing from a trusted proxy", async () => {
    // 证伪: logging whenever forwarded headers exist, trusted or not → red.
    const t = await makeTestApp();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await login(t, fromPeer("127.0.0.1"), {
        "X-Forwarded-Proto": "https",
      });
      expect(res.headers.get("set-cookie")).toContain("Secure");
      expect(
        errSpy.mock.calls
          .map((args) => args.join(" "))
          .filter((line) => line.includes("proxy headers ignored")),
      ).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
      await t.cleanup();
    }
  });

  it("traces nothing when no forwarded headers are present", async () => {
    // 证伪: dropping the has-forwarded-headers premise → red; every direct
    // request would log while the positive case above stays green.
    const t = await makeTestApp();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await login(t, fromPeer("10.9.9.9"));
      expect(
        errSpy.mock.calls
          .map((args) => args.join(" "))
          .filter((line) => line.includes("proxy headers ignored")),
      ).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
      await t.cleanup();
    }
  });

  it("names exactly the headers the request carried", async () => {
    // 证伪: hardcoding the proto/host pair → red on both not-contains.
    // A deployment whose proxies only send x-forwarded-for would otherwise
    // get a line claiming two headers that were never on the request. The
    // line names the peer, not the client address the header asserts —
    // conflating them reads the log as a different event.
    const t = await makeTestApp();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await login(t, fromPeer("10.9.9.9"), {
        "X-Forwarded-For": "203.0.113.7",
      });
      const logged = errSpy.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.includes("proxy headers ignored"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("x-forwarded-for");
      expect(logged[0]).toContain("10.9.9.9");
      expect(logged[0]).not.toContain("x-forwarded-proto");
      expect(logged[0]).not.toContain("x-forwarded-host");
      expect(logged[0]).not.toContain("203.0.113.7");
    } finally {
      errSpy.mockRestore();
      await t.cleanup();
    }
  });
});
