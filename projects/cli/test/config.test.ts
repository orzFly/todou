import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@todou/shared/config";
import { afterAll, describe, expect, it } from "vitest";
import {
  configPath,
  discoverConfigFiles,
  loadCliConfig,
  loadCliConfigSet,
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
        servers: {
          "https://todou.example": {
            token: "todou_pat_x",
            tokens: {},
            instead_of: [],
          },
        },
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

  it("writes no [agent] section for a config that has no preference", () => {
    // The reason the table is optional rather than defaulted: every `todou
    // login` rewrites this file, and a defaulted table would grow a section
    // into it that nobody asked for.
    const env = envFor("no-agent");
    saveCliConfig({ servers: {}, bindings: [] }, env);
    expect(readFileSync(configPath(env), "utf8")).not.toContain("agent");
    expect(loadCliConfig(env).agent).toBeUndefined();
  });

  it("round-trips the uds opt-out", () => {
    const env = envFor("agent-opt-out");
    saveCliConfig(
      { servers: {}, bindings: [], agent: { follow_uds: false } },
      env,
    );
    expect(loadCliConfig(env).agent).toEqual({ follow_uds: false });
  });

  it("chmods the file to 0600", () => {
    const env = envFor("perms");
    saveCliConfig({ servers: {}, bindings: [] }, env);
    const mode = statSync(configPath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps a hand-written instead_of through a rewrite", () => {
    // Hand-editing is the only way to write this key, and `saveCliConfig`
    // rewrites the whole document from the parsed config — so a key the
    // schema did not know would be dropped by the next `todou login`.
    const env = envFor("instead-of");
    const path = configPath(env);
    mkdirSync(join(env.XDG_CONFIG_HOME, "todou"), { recursive: true });
    writeFileSync(
      path,
      [
        'default_server = "http://198.51.100.7/todou"',
        "",
        '[servers."http://198.51.100.7/todou"]',
        'token = "todou_pat_fallback"',
        'instead_of = ["https://todou.example"]',
        "",
      ].join("\n"),
    );
    const loaded = loadCliConfig(env);
    expect(loaded.servers["http://198.51.100.7/todou"]?.instead_of).toEqual([
      "https://todou.example",
    ]);
    saveCliConfig(loaded, env);
    expect(loadCliConfig(env).servers["http://198.51.100.7/todou"]).toEqual({
      token: "todou_pat_fallback",
      tokens: {},
      instead_of: ["https://todou.example"],
    });
  });

  it("writes no instead_of for an entry that has none", () => {
    // Defaulted like `tokens`, and deleted the same way: otherwise every
    // login would grow an `instead_of = []` into a file nobody asked it to.
    const env = envFor("no-instead-of");
    saveCliConfig(
      {
        servers: { "https://todou.example": { tokens: {}, instead_of: [] } },
        bindings: [],
      },
      env,
    );
    const written = readFileSync(configPath(env), "utf8");
    expect(written).not.toContain("instead_of");
    expect(written).not.toContain("tokens");
    expect(
      loadCliConfig(env).servers["https://todou.example"]?.instead_of,
    ).toEqual([]);
  });
});

describe("normalizeServer", () => {
  it("strips trailing slashes only", () => {
    expect(normalizeServer("https://todou.example/")).toBe(
      "https://todou.example",
    );
    expect(normalizeServer("http://localhost:8637")).toBe(
      "http://localhost:8637",
    );
  });
});

describe("discoverConfigFiles", () => {
  it("lists fragments sorted, then config.toml appended last", () => {
    const env = envFor("discover");
    const dir = join(env.XDG_CONFIG_HOME, "todou");
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "config.b.toml",
      "config.10-work.toml",
      "config.a.toml",
      "config.toml",
    ]) {
      writeFileSync(join(dir, name), "# fragment\n");
    }
    expect(discoverConfigFiles(env)).toEqual([
      join(dir, "config.10-work.toml"),
      join(dir, "config.a.toml"),
      join(dir, "config.b.toml"),
      join(dir, "config.toml"),
    ]);
  });

  it("ignores lookalikes, and a directory named config.x.toml", () => {
    const env = envFor("discover-lookalikes");
    const dir = join(env.XDG_CONFIG_HOME, "todou");
    mkdirSync(join(dir, "config.x.toml"), { recursive: true });
    for (const name of [
      "config.toml.bak",
      "configx.toml",
      "config..toml",
      "other.toml",
    ]) {
      writeFileSync(join(dir, name), "# no\n");
    }
    expect(discoverConfigFiles(env)).toEqual([join(dir, "config.toml")]);
  });

  it("returns only config.toml when the directory does not exist", () => {
    const env = envFor("discover-absent");
    expect(discoverConfigFiles(env)).toEqual([configPath(env)]);
  });
});

describe("loadCliConfigSet", () => {
  function fragment(
    env: Record<string, string | undefined>,
    name: string,
    body: string,
  ) {
    const dir = join(String(env.XDG_CONFIG_HOME), "todou");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
  }

  it("later fragments win, and config.toml wins over both", () => {
    const env = envFor("merge-order");
    fragment(env, "config.a.toml", 'default_server = "https://a.example"\n');
    fragment(env, "config.b.toml", 'default_server = "https://b.example"\n');
    fragment(env, "config.toml", 'default_server = "https://own.example"\n');
    const { config, own } = loadCliConfigSet(env);
    expect(config.default_server).toBe("https://own.example");
    expect(own.default_server).toBe("https://own.example");
  });

  it("merges token profiles of the same server across files", () => {
    const env = envFor("merge-profiles");
    fragment(
      env,
      "config.work.toml",
      [
        '[servers."http://198.51.100.7/todou"]',
        'name = "work"',
        'tokens = { "claude-code" = "todou_pat_a" }',
        "",
      ].join("\n"),
    );
    fragment(
      env,
      "config.toml",
      [
        '[servers."http://198.51.100.7/todou"]',
        'instead_of = ["https://todou.example"]',
        "",
      ].join("\n"),
    );
    const { config, own } = loadCliConfigSet(env);
    const entry = config.servers["http://198.51.100.7/todou"];
    // Both survive: single validation on the merged raw documents, where
    // per-file zod defaults would have wiped one side with `= []`/`{}`.
    expect(entry).toEqual({
      name: "work",
      tokens: { "claude-code": "todou_pat_a" },
      instead_of: ["https://todou.example"],
    });
    expect(own.servers["http://198.51.100.7/todou"]).toEqual({
      tokens: {},
      instead_of: ["https://todou.example"],
    });
  });

  it("concatenates bindings across files, later entries winning the lookup", () => {
    const env = envFor("merge-bindings");
    const remote = "git@example.com:me/repo.git";
    fragment(
      env,
      "config.frag.toml",
      [
        "[[bindings]]",
        `remote = "${remote}"`,
        'server = "https://frag.example"',
        'project = "from-frag"',
        "",
        "[[bindings]]",
        'remote = "git@example.com:me/other.git"',
        'server = "https://frag.example"',
        'project = "other"',
        "",
      ].join("\n"),
    );
    fragment(
      env,
      "config.toml",
      [
        "[[bindings]]",
        `remote = "${remote}"`,
        'server = "https://own.example"',
        'project = "from-own"',
        "",
      ].join("\n"),
    );
    const { config } = loadCliConfigSet(env);
    expect(config.bindings).toEqual([
      { remote, server: "https://frag.example", project: "from-frag" },
      {
        remote: "git@example.com:me/other.git",
        server: "https://frag.example",
        project: "other",
      },
      { remote, server: "https://own.example", project: "from-own" },
    ]);
    const last = config.bindings.filter((b) => b.remote === remote).at(-1);
    expect(last?.project).toBe("from-own");
  });

  it("replaces arrays like instead_of whole", () => {
    const env = envFor("merge-replace-arrays");
    fragment(
      env,
      "config.a.toml",
      [
        '[servers."http://198.51.100.7/todou"]',
        'instead_of = ["https://one.example", "https://two.example"]',
        "",
      ].join("\n"),
    );
    fragment(
      env,
      "config.toml",
      [
        '[servers."http://198.51.100.7/todou"]',
        'instead_of = ["https://three.example"]',
        "",
      ].join("\n"),
    );
    const { config } = loadCliConfigSet(env);
    expect(config.servers["http://198.51.100.7/todou"]?.instead_of).toEqual([
      "https://three.example",
    ]);
  });

  it("a broken fragment fails the load naming that file", () => {
    const env = envFor("broken-fragment");
    fragment(env, "config.bad.toml", "name = [broken\n");
    expect(() => loadCliConfigSet(env)).toThrow(/config\.bad\.toml/);
  });

  it("a broken config.toml fails the load instead of reading as empty", () => {
    // Today `optional: true` swallows a syntax error, and every command
    // then reports "no server configured" without a word about why.
    const env = envFor("broken-own");
    fragment(env, "config.toml", "name = [broken\n");
    expect(() => loadCliConfig(env)).toThrow(/config\.toml/);
  });

  it("no file at all is the empty config, as today", () => {
    const { config, own, files } = loadCliConfigSet(envFor("merge-empty"));
    expect(config).toEqual({ servers: {}, bindings: [] });
    expect(own).toEqual({ servers: {}, bindings: [] });
    expect(files).toEqual([]);
  });

  it("rejects a server name with characters a URL could need", () => {
    const env = envFor("bad-name");
    fragment(
      env,
      "config.toml",
      ['[servers."https://todou.example"]', 'name = "not:a name"', ""].join(
        "\n",
      ),
    );
    expect(() => loadCliConfig(env)).toThrow(ConfigError);
    const env2 = envFor("bad-name-2");
    fragment(
      env2,
      "config.toml",
      ['[servers."https://todou.example"]', 'name = "/etc"', ""].join("\n"),
    );
    expect(() => loadCliConfig(env2)).toThrow(ConfigError);
  });
});
