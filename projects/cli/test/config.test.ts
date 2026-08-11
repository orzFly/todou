import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  configPath,
  loadCliConfig,
  normalizeServer,
  saveCliConfig,
} from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "todou-cli-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function envFor(name: string) {
  return { XDG_CONFIG_HOME: join(dir, name) };
}

describe("configPath", () => {
  it("prefers XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe(
      join("/x", "todou", "config.toml"),
    );
  });

  it("falls back to ~/.config", () => {
    expect(configPath({})).toMatch(/\.config\/todou\/config\.toml$/);
  });
});

describe("load/save round-trip", () => {
  it("missing file loads as empty config", () => {
    const config = loadCliConfig(envFor("fresh"));
    expect(config).toEqual({ servers: {}, bindings: [] });
  });

  it("persists servers, bindings, and default_server", () => {
    const env = envFor("roundtrip");
    saveCliConfig(
      {
        default_server: "https://todou.example",
        servers: { "https://todou.example": { token: "todou_pat_x" } },
        bindings: [
          {
            remote: "git@example.com:me/repo.git",
            server: "https://todou.example",
            project: "todou",
          },
        ],
      },
      env,
    );
    const config = loadCliConfig(env);
    expect(config.default_server).toBe("https://todou.example");
    expect(config.servers["https://todou.example"]?.token).toBe("todou_pat_x");
    expect(config.bindings[0]?.project).toBe("todou");
  });

  it("omits undefined default_server instead of writing a bad value", () => {
    const env = envFor("no-default");
    saveCliConfig({ servers: {}, bindings: [] }, env);
    expect(readFileSync(configPath(env), "utf8")).not.toContain(
      "default_server",
    );
  });

  it("chmods the file to 0600", () => {
    const env = envFor("perms");
    saveCliConfig({ servers: {}, bindings: [] }, env);
    const mode = statSync(configPath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("normalizeServer", () => {
  it("strips trailing slashes only", () => {
    expect(normalizeServer("https://todou.example/")).toBe("https://todou.example");
    expect(normalizeServer("http://localhost:8637")).toBe(
      "http://localhost:8637",
    );
  });
});
