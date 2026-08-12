import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, compileUrlTemplate, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("applies defaults with empty input", () => {
    const config = loadConfig({ tomlSource: "", env: {} });
    expect(config.auth.mode).toBe("single");
    expect(config.http.port).toBe(8637);
    expect(config.database.system).toBe("pglite://./data/system");
    expect(config.database.projects.placement).toBe("shared");
    expect(config.storage.backend).toBe("fs");
    expect(config.storage.max_upload_mb).toBe(20);
    expect(config.projectUrlFor).toBeNull();
  });

  it("reads TOML values", () => {
    const config = loadConfig({
      tomlSource: ["[http]", "port = 4000"].join("\n"),
      env: {},
    });
    expect(config.http.port).toBe(4000);
  });

  it("lets ENV win over TOML", () => {
    const config = loadConfig({
      tomlSource: ["[http]", "port = 4000"].join("\n"),
      env: { TODOU_HTTP_PORT: "5000" },
    });
    expect(config.http.port).toBe(5000);
  });

  it("leaves static_dir unset by default", () => {
    const config = loadConfig({ tomlSource: "", env: {} });
    expect(config.http.static_dir).toBeUndefined();
  });

  // serveStatic resolves a relative root against the CWD, which in production
  // is the state directory rather than the checkout.
  it("absolutises a relative static_dir", () => {
    const config = loadConfig({
      tomlSource: ["[http]", "static_dir = './projects/web/dist'"].join("\n"),
      env: {},
    });
    expect(config.http.static_dir).toBe(
      resolve(process.cwd(), "projects/web/dist"),
    );
  });

  it("reads static_dir from ENV", () => {
    const config = loadConfig({
      tomlSource: "",
      env: { TODOU_HTTP_STATIC_DIR: "/srv/todou/dist" },
    });
    expect(config.http.static_dir).toBe("/srv/todou/dist");
  });

  it("requires issuer, client_id, and client_secret for oidc mode", () => {
    const base = [
      "[auth]",
      'mode = "oidc"',
      "[auth.oidc]",
      'issuer = "https://auth.example.com"',
      'client_id = "todou"',
      'client_secret = "s3cret"',
    ];
    expect(() =>
      loadConfig({ tomlSource: base.join("\n"), env: {} }),
    ).not.toThrow();
    for (const missing of ["issuer", "client_id", "client_secret"]) {
      const lines = base.filter((l) => !l.startsWith(missing));
      expect(() =>
        loadConfig({ tomlSource: lines.join("\n"), env: {} }),
      ).toThrow(new RegExp(`auth\\.oidc\\.${missing} is required`));
    }
  });

  it("fills oidc defaults for scopes, login_claim, and auto_create", () => {
    const config = loadConfig({ tomlSource: "", env: {} });
    expect(config.auth.oidc.scopes).toBe("openid profile email");
    expect(config.auth.oidc.login_claim).toBe("preferred_username");
    expect(config.auth.oidc.auto_create).toBe(true);
    expect(config.auth.forward.auto_create).toBe(true);
  });

  it("requires user_header for forward mode", () => {
    expect(() =>
      loadConfig({ tomlSource: '[auth]\nmode = "forward"', env: {} }),
    ).toThrow(/user_header is required/);
    const config = loadConfig({
      tomlSource: [
        "[auth]",
        'mode = "forward"',
        "[auth.forward]",
        'user_header = "Remote-User"',
      ].join("\n"),
      env: {},
    });
    expect(config.auth.forward.user_header).toBe("Remote-User");
  });

  it("leaves cookie_secure a tri-state (absent = per request)", () => {
    expect(
      loadConfig({ tomlSource: "", env: {} }).auth.cookie_secure,
    ).toBeUndefined();
    expect(
      loadConfig({ tomlSource: "[auth]\ncookie_secure = false", env: {} }).auth
        .cookie_secure,
    ).toBe(false);
    expect(
      loadConfig({ tomlSource: "", env: { TODOU_AUTH_COOKIE_SECURE: "1" } })
        .auth.cookie_secure,
    ).toBe(true);
  });

  it("normalises public_origin and rejects non-origin shapes", () => {
    const config = loadConfig({
      tomlSource: '[http]\npublic_origin = "https://todou.example/"',
      env: {},
    });
    expect(config.http.public_origin).toBe("https://todou.example");
    for (const bad of [
      "todou.example",
      "ftp://todou.example",
      "https://todou.example/app",
      "https://todou.example/?x=1",
      "https://user:pw@todou.example",
    ]) {
      expect(() =>
        loadConfig({
          tomlSource: `[http]\npublic_origin = "${bad}"`,
          env: {},
        }),
      ).toThrow(/public_origin/);
    }
  });

  it("defaults trusted_proxies to loopback and splits the ENV form", () => {
    const config = loadConfig({ tomlSource: "", env: {} });
    expect(config.http.trusted_proxies).toEqual(["127.0.0.1/32", "::1/128"]);
    expect(config.isTrustedPeer("127.0.0.1")).toBe(true);
    expect(config.isTrustedPeer("10.0.0.1")).toBe(false);

    const fromEnv = loadConfig({
      tomlSource: "",
      env: { TODOU_HTTP_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.1" },
    });
    expect(fromEnv.http.trusted_proxies).toEqual(["10.0.0.0/8", "192.168.1.1"]);
    expect(fromEnv.isTrustedPeer("10.20.30.40")).toBe(true);
    expect(fromEnv.isTrustedPeer("127.0.0.1")).toBe(false);
  });

  it("rejects malformed trusted_proxies entries at startup", () => {
    for (const bad of ["proxy.internal", "10.0.0.0/33", "10.0.0.0/8/x"]) {
      expect(() =>
        loadConfig({
          tomlSource: `[http]\ntrusted_proxies = ["${bad}"]`,
          env: {},
        }),
      ).toThrow(ConfigError);
    }
  });

  it("fills database.pool defaults and reads overrides from ENV", () => {
    const config = loadConfig({ tomlSource: "", env: {} });
    expect(config.database.pool).toEqual({
      max: 10,
      idle_timeout_ms: 10_000,
      connection_timeout_ms: 0,
    });
    const tuned = loadConfig({
      tomlSource: "",
      env: {
        TODOU_DATABASE_POOL_MAX: "25",
        TODOU_DATABASE_POOL_CONNECTION_TIMEOUT_MS: "3000",
      },
    });
    expect(tuned.database.pool.max).toBe(25);
    expect(tuned.database.pool.connection_timeout_ms).toBe(3000);
  });

  it("rejects non-database system URLs", () => {
    expect(() =>
      loadConfig({
        tomlSource: '[database]\nsystem = "mysql://nope"',
        env: {},
      }),
    ).toThrow(ConfigError);
  });

  it("requires url_template for dedicated placement", () => {
    expect(() =>
      loadConfig({
        tomlSource: '[database.projects]\nplacement = "dedicated"',
        env: {},
      }),
    ).toThrow(/url_template is required/);
  });

  it("defaults workers by placement: on for dedicated, off for shared", () => {
    const shared = loadConfig({ tomlSource: "", env: {} });
    expect(shared.database.projects.workers).toBe(false);

    const dedicated = loadConfig({
      tomlSource: [
        "[database.projects]",
        'placement = "dedicated"',
        "url_template = 'pglite://./data/projects/${project.id}'",
      ].join("\n"),
      env: {},
    });
    expect(dedicated.database.projects.workers).toBe(true);
  });

  it("lets an explicit workers value override the placement default", () => {
    const config = loadConfig({
      tomlSource: [
        "[database.projects]",
        'placement = "dedicated"',
        "url_template = 'pglite://./data/projects/${project.id}'",
        "workers = false",
      ].join("\n"),
      env: {},
    });
    expect(config.database.projects.workers).toBe(false);
  });

  it("compiles a dedicated template at load time", () => {
    const config = loadConfig({
      tomlSource: [
        "[database.projects]",
        'placement = "dedicated"',
        "url_template = 'pglite://./data/projects/${project.id}'",
      ].join("\n"),
      env: {},
    });
    expect(
      config.projectUrlFor?.({ id: 7, slug: "x", database_url: null }),
    ).toBe("pglite://./data/projects/7");
  });
});

describe("compileUrlTemplate", () => {
  it("supports arbitrary logic inside ${}", () => {
    const resolve = compileUrlTemplate(
      "postgres://${project.id > 100 ? 'pg-b' : 'pg-a'}/todou_${project.id}",
    );
    expect(resolve({ id: 7, slug: "s" })).toBe("postgres://pg-a/todou_7");
    expect(resolve({ id: 101, slug: "s" })).toBe("postgres://pg-b/todou_101");
  });

  it("rejects templates that fail to compile", () => {
    expect(() => compileUrlTemplate("pglite://${")).toThrow(ConfigError);
  });

  it("rejects templates resolving to non-database URLs at startup", () => {
    expect(() =>
      compileUrlTemplate("http://example.com/${project.id}"),
    ).toThrow(ConfigError);
  });

  it("rejects templates that throw at resolution", () => {
    expect(() =>
      compileUrlTemplate("pglite://${project.missing.deep}"),
    ).toThrow(ConfigError);
  });
});
