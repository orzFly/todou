import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigError,
  deepMergeDocs,
  flexibleBool,
  loadTomlConfig,
  loadTomlDocs,
  readTomlDocument,
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

  it("reads a TOML file from disk", async () => {
    const path = join(dir, "ok.toml");
    writeFileSync(path, 'name = "from-file"\n');
    const config = loadTomlConfig({
      schema: Schema,
      document: await readTomlDocument(path),
    });
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

  it("missing optional path yields pure defaults", async () => {
    const config = loadTomlConfig({
      schema: Schema,
      document: await readTomlDocument(join(dir, "does-not-exist.toml"), true),
    });
    expect(config.name).toBe("todou");
  });

  it("missing required path throws ConfigError", async () => {
    await expect(readTomlDocument(join(dir, "nope.toml"))).rejects.toThrow(
      ConfigError,
    );
  });

  it("schema violations throw ConfigError", () => {
    expect(() =>
      loadTomlConfig({ schema: Schema, tomlSource: '[http]\nport = "x"\n' }),
    ).toThrow(/invalid config/);
  });
});

describe("deepMergeDocs", () => {
  it("later documents override earlier scalars", () => {
    const merged = deepMergeDocs([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(merged).toEqual({ a: 3 });
  });

  it("merges nested tables key by key instead of replacing whole", () => {
    const merged = deepMergeDocs([
      { servers: { a: { token: "x" }, b: { token: "y" } } },
      { servers: { a: { name: "work" } } },
    ]);
    expect(merged).toEqual({
      servers: { a: { token: "x", name: "work" }, b: { token: "y" } },
    });
  });

  it("replaces arrays whole by default", () => {
    const merged = deepMergeDocs([
      { entry: { instead_of: ["https://a.test"] } },
      { entry: { instead_of: ["https://b.test"] } },
    ]);
    expect(merged).toEqual({ entry: { instead_of: ["https://b.test"] } });
  });

  it("concatenates arrays at a path listed in concatArrays", () => {
    const merged = deepMergeDocs(
      [
        { bindings: [{ remote: "a" }], servers: { s: { instead_of: ["x"] } } },
        { bindings: [{ remote: "b" }], servers: { s: { instead_of: ["y"] } } },
      ],
      { concatArrays: [["bindings"]] },
    );
    expect(merged).toEqual({
      bindings: [{ remote: "a" }, { remote: "b" }],
      servers: { s: { instead_of: ["y"] } },
    });
  });

  it("keeps datetime values intact instead of shredding them as objects", () => {
    const doc = parseToml("at = 1979-05-27T07:32:00Z\n") as Record<
      string,
      unknown
    >;
    const merged = deepMergeDocs([doc]) as { at: Date };
    expect(merged.at).toBeInstanceOf(Date);
    expect(new Date(merged.at).toISOString()).toBe("1979-05-27T07:32:00.000Z");
  });
});

describe("loadTomlDocs", () => {
  it("returns documents in the order given", async () => {
    const a = join(dir, "order-a.toml");
    const b = join(dir, "order-b.toml");
    writeFileSync(a, 'name = "a"\n');
    writeFileSync(b, 'name = "b"\n');
    const docs = await loadTomlDocs({ paths: [b, a] });
    expect(docs.map((d) => d.path)).toEqual([b, a]);
  });

  it("skips a file that does not exist", async () => {
    const path = join(dir, "absent.toml");
    expect(await loadTomlDocs({ paths: [path] })).toEqual([]);
  });

  it("throws ConfigError naming the file on bad TOML", async () => {
    const path = join(dir, "broken.toml");
    writeFileSync(path, "name = [broken\n");
    await expect(loadTomlDocs({ paths: [path] })).rejects.toThrow(
      new RegExp(path.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await expect(loadTomlDocs({ paths: [path] })).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError on a file it cannot read", async () => {
    const path = join(dir, "unreadable.toml");
    writeFileSync(path, 'name = "x"\n');
    chmodSync(path, 0o000);
    try {
      await expect(loadTomlDocs({ paths: [path] })).rejects.toThrow(
        ConfigError,
      );
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("throws ConfigError on a directory", async () => {
    const path = join(dir, "a-directory.toml");
    mkdirSync(path);
    await expect(loadTomlDocs({ paths: [path] })).rejects.toThrow(ConfigError);
  });
});

describe("setPath", () => {
  it("creates intermediate objects and overwrites scalars", () => {
    const target: Record<string, unknown> = { a: 1 };
    setPath(target, ["a", "b", "c"], 2);
    expect(target).toEqual({ a: { b: { c: 2 } } });
  });
});
