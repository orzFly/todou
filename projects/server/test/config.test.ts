import { describe, expect, it } from "vitest";
import { ConfigError, compileUrlTemplate, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("applies defaults with empty input", () => {
    const config = loadConfig({ tomlSource: "", env: {} });
    expect(config.auth.mode).toBe("single");
    expect(config.http.port).toBe(3000);
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

  it("rejects unimplemented auth modes", () => {
    expect(() =>
      loadConfig({ tomlSource: '[auth]\nmode = "oidc"', env: {} }),
    ).toThrow(ConfigError);
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
