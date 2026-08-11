import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigError,
  flexibleBool,
  loadTomlConfig,
  setPath,
} from "../src/config.ts";

const Schema = z.object({
  name: z.string().default("todou"),
  http: z
    .object({
      port: z.coerce.number().int().default(1234),
      secure: flexibleBool.default(false),
    })
    .prefault({}),
});

const dir = mkdtempSync(join(tmpdir(), "todou-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadTomlConfig", () => {
  it("parses TOML source with defaults", () => {
    const config = loadTomlConfig({
      schema: Schema,
      tomlSource: "[http]\nport = 9000\n",
    });
    expect(config).toEqual({
      name: "todou",
      http: { port: 9000, secure: false },
    });
  });

  it("reads a TOML file from disk", () => {
    const path = join(dir, "ok.toml");
    writeFileSync(path, 'name = "from-file"\n');
    const config = loadTomlConfig({ schema: Schema, path });
    expect(config.name).toBe("from-file");
  });

  it("env overrides TOML and coerces strings", () => {
    const config = loadTomlConfig({
      schema: Schema,
      tomlSource: "[http]\nport = 9000\nsecure = false\n",
      envMap: [
        ["APP_PORT", ["http", "port"]],
        ["APP_SECURE", ["http", "secure"]],
      ],
      env: { APP_PORT: "4321", APP_SECURE: "1" },
    });
    expect(config.http).toEqual({ port: 4321, secure: true });
  });

  it("ignores empty env values", () => {
    const config = loadTomlConfig({
      schema: Schema,
      tomlSource: "[http]\nport = 9000\n",
      envMap: [["APP_PORT", ["http", "port"]]],
      env: { APP_PORT: "" },
    });
    expect(config.http.port).toBe(9000);
  });

  it("missing optional path yields pure defaults", () => {
    const config = loadTomlConfig({
      schema: Schema,
      path: join(dir, "does-not-exist.toml"),
      optional: true,
    });
    expect(config.name).toBe("todou");
  });

  it("missing required path throws ConfigError", () => {
    expect(() =>
      loadTomlConfig({ schema: Schema, path: join(dir, "nope.toml") }),
    ).toThrow(ConfigError);
  });

  it("schema violations throw ConfigError", () => {
    expect(() =>
      loadTomlConfig({ schema: Schema, tomlSource: '[http]\nport = "x"\n' }),
    ).toThrow(/invalid config/);
  });
});

describe("setPath", () => {
  it("creates intermediate objects and overwrites scalars", () => {
    const target: Record<string, unknown> = { a: 1 };
    setPath(target, ["a", "b", "c"], 2);
    expect(target).toEqual({ a: { b: { c: 2 } } });
  });
});
