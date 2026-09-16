import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ConfigReport } from "../src/commands/config.ts";
import type { CliConfig } from "../src/config.ts";
import { configPath, saveCliConfig } from "../src/config.ts";
import { displayPath } from "../src/dir-config.ts";
import { runCli } from "./harness.ts";

/**
 * Fake credentials, and deliberately not spelled `todou_pat_…` like the rest
 * of this suite's fixtures: `assertNoTokenMaterial` forbids every 4-character
 * run of a sentinel from reaching the output, and a shared `todou_pat_`
 * prefix would trip on the `todou` in the banner rather than on a leak. Each
 * one is distinct so a test cannot pass by leaking one and checking another.
 */
const SENTINELS = {
  default: "FAKE_Z7QVKXJ3MW9TB4HF",
  claude: "FAKE_R5NDYP2GCJ8LVQ6X",
  harness: "FAKE_W3TKM7BZQ9XFHR2D",
  other: "FAKE_K8PGV4SNJ6YRDT5C",
  env: "FAKE_M2XCLB9HQ7WZFV3N",
};

/**
 * The guard T-185 exists for, and it is stricter than "the token is absent":
 * no *material* derived from it may be present either. Every 4-character
 * window is forbidden, which closes the tempting middle grounds in one
 * assertion — a truncated value, a last-four echo, a prefix reused as an id.
 * Four is short enough that any longer fragment contains one of these.
 */
function assertNoTokenMaterial(output: string, sentinel: string): void {
  for (let i = 0; i + 4 <= sentinel.length; i++) {
    const window = sentinel.slice(i, i + 4);
    expect(
      output,
      `token material "${window}" reached the output`,
    ).not.toContain(window);
  }
}

function assertNoSentinels(output: string): void {
  for (const sentinel of Object.values(SENTINELS)) {
    assertNoTokenMaterial(output, sentinel);
  }
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "todou-config-show-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A config file under its own XDG root, and the env that finds it. */
function seed(name: string, config: CliConfig): Record<string, string> {
  const env = { XDG_CONFIG_HOME: join(dir, name) };
  saveCliConfig(config, env);
  return env;
}

function makeRepo(name: string, remote: string): string {
  const repo = join(dir, name);
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  return repo;
}

function writeDirConfig(cwd: string, body: string): void {
  writeFileSync(join(cwd, ".todou.toml"), body);
}

type Options = Parameters<typeof runCli>[1];

/**
 * Both renderings of one situation, each swept for token material. Every
 * scenario goes through here: a leak that only the human path or only the
 * JSON path produced would otherwise be invisible to half the matrix.
 */
async function show(options: Options) {
  const human = await runCli(["config", "show"], options);
  const json = await runCli(["config", "show", "--json"], options);
  assertNoSentinels(human.stdout + human.stderr);
  assertNoSentinels(json.stdout + json.stderr);
  expect(human.exitCode).toBe(0);
  expect(json.exitCode).toBe(0);
  return {
    human: human.stdout,
    report: JSON.parse(json.stdout) as ConfigReport,
  };
}

const TWO_SERVERS: CliConfig = {
  default_server: "https://todou.example",
  servers: {
    "https://todou.example": {
      token: SENTINELS.default,
      tokens: { "claude-code": SENTINELS.claude, harness: SENTINELS.harness },
      instead_of: [],
    },
    "https://staging.example": {
      tokens: { "bot-one": SENTINELS.other },
      instead_of: [],
    },
  },
  bindings: [],
};

describe("config show", () => {
  it("reports two servers, their profiles, and the winning source", async () => {
    const env = seed("two-servers", TWO_SERVERS);
    const { human, report } = await show({ env });

    // Whole-output equality, on purpose (T-185 design §五③): a sliding
    // window cannot catch a *derived* leak such as a hash or a
    // last-four fingerprint, but any new field at all breaks this line.
    // Widening it to `toContain`/`toMatchObject` would retire the guard —
    // if a field belongs here, change the expectation deliberately.
    expect(human).toBe(
      [
        "todou 0.0.0-test",
        `user config: ${configPath(env)}`,
        "directory config: none",
        "",
        "context:",
        "  server: https://todou.example (default_server)",
        "  token: default token",
        "  project: none",
        "",
        "servers:",
        "  https://staging.example — default token: none · profiles: bot-one",
        "* https://todou.example — default token: set · profiles: claude-code, harness",
        "",
        "bindings: none",
        "",
      ].join("\n"),
    );

    // Same job, same rule: `toEqual`, never `toMatchObject` — widened for
    // the new fields the report carries since names and fragments (T-366).
    expect(report).toEqual({
      version: "0.0.0-test",
      config_path: configPath(env),
      config_exists: true,
      config_files: [configPath(env)],
      dir_config: null,
      git_remote: null,
      context: {
        server: "https://todou.example",
        server_source: "default_server",
        server_instead_of: null,
        server_name: null,
        server_unknown_name: false,
        token_source: "default",
        token_profile: null,
        project: null,
        project_source: null,
      },
      servers: [
        {
          origin: "https://staging.example",
          active: false,
          name: null,
          default_token: false,
          profiles: ["bot-one"],
          instead_of: [],
        },
        {
          origin: "https://todou.example",
          active: true,
          name: null,
          default_token: true,
          profiles: ["claude-code", "harness"],
          instead_of: [],
        },
      ],
      bindings: [],
      agent: { follow_uds: true },
    });
  });

  it("names the uds opt-out, and only when it is set", async () => {
    const off = seed("uds-opted-out", {
      ...TWO_SERVERS,
      agent: { follow_uds: false },
    });
    const { human, report } = await show({ env: off });

    expect(human).toContain("\n\n--follow=uds: opted out");
    expect(report.agent).toEqual({ follow_uds: false });
    // No way back out of it here: this is a command agents run, and the
    // switch is the user's to throw. `opt-out-uds`'s own receipt says it.
    expect(human).not.toContain("opt-in-uds");

    const on = await show({ env: seed("uds-advised", TWO_SERVERS) });
    expect(on.human).not.toContain("--follow=uds");
    expect(on.report.agent).toEqual({ follow_uds: true });
  });

  it("names TODOU_TOKEN as the source without echoing it", async () => {
    const env = {
      ...seed("env-token", TWO_SERVERS),
      TODOU_TOKEN: SENTINELS.env,
    };
    const { human, report } = await show({ env });

    expect(human).toContain("  token: TODOU_TOKEN (env)");
    expect(report.context).toEqual({
      server: "https://todou.example",
      server_source: "default_server",
      server_instead_of: null,
      server_name: null,
      server_unknown_name: false,
      token_source: "env-token",
      token_profile: null,
      project: null,
      project_source: null,
    });
  });

  it("names the profile a detected harness selected", async () => {
    const env = { ...seed("harness", TWO_SERVERS), CLAUDECODE: "1" };
    const { human, report } = await show({ env });

    expect(human).toContain(
      '  token: profile "claude-code" (auto-detected harness)',
    );
    expect(report.context.token_source).toBe("auto-harness");
    expect(report.context.token_profile).toBe("claude-code");
  });

  it("shows a directory config shadowing the binding it sits beside", async () => {
    const remote = "git@git.example:org/repo.git";
    const cwd = makeRepo("shadowed", remote);
    const env = seed("shadowed-xdg", {
      default_server: "https://todou.example",
      servers: {
        "https://todou.example": {
          token: SENTINELS.default,
          tokens: { "claude-code": SENTINELS.claude },
          instead_of: [],
        },
      },
      bindings: [{ remote, server: "https://todou.example", project: "bound" }],
    });
    // No server key: the file replaces the binding outright, so the server
    // falls through to default_server rather than to the binding's.
    writeDirConfig(cwd, 'project = "dirproj"\n');

    const { human, report } = await show({ env, cwd });

    expect(human).toContain("directory config: ./.todou.toml");
    expect(human).toContain("  server: https://todou.example (default_server)");
    expect(human).toContain(
      "  project: dirproj (directory config ./.todou.toml)",
    );
    expect(human).toContain(
      `* ${remote} → https://todou.example · project bound`,
    );
    expect(human).not.toContain("no binding");
    expect(report.dir_config).toEqual({
      path: join(cwd, ".todou.toml"),
      project: "dirproj",
      server: null,
    });
    expect(report.context.server_source).toBe("default_server");
    expect(report.context.project_source).toBe("dir-config");
    expect(report.bindings).toEqual([
      {
        remote,
        server: "https://todou.example",
        project: "bound",
        source: configPath(env),
        active: true,
      },
    ]);
  });

  it("says so when this repository's remote matches no binding", async () => {
    const remote = "git@git.example:org/unbound.git";
    const cwd = makeRepo("unbound", remote);
    const env = seed("unbound-xdg", {
      default_server: "https://todou.example",
      servers: {
        "https://todou.example": {
          token: SENTINELS.default,
          tokens: {},
          instead_of: [],
        },
      },
      bindings: [
        {
          remote: "git@git.example:org/other.git",
          server: "https://todou.example",
          project: "other",
        },
      ],
    });

    const { human, report } = await show({ env, cwd });

    expect(human).toContain(`git remote: ${remote} (no binding)`);
    expect(human).toContain(
      "  git@git.example:org/other.git → https://todou.example · project other",
    );
    expect(human).toContain("  project: none");
    expect(report.bindings[0]?.active).toBe(false);
    expect(report.servers).toEqual([
      {
        origin: "https://todou.example",
        active: true,
        name: null,
        default_token: true,
        profiles: [],
        instead_of: [],
      },
    ]);
  });

  it("answers in full with nothing configured at all", async () => {
    // The state `whoami` cannot reach: no config file, no server, no token.
    const env = { XDG_CONFIG_HOME: join(dir, "absent") };
    const { human, report } = await show({ env });

    expect(human).toBe(
      [
        "todou 0.0.0-test",
        `user config: ${configPath(env)} (not found)`,
        "directory config: none",
        "",
        "context:",
        "  server: none (pass --server, set TODOU_SERVER, or run `todou login <origin>`)",
        "  token: none",
        "  project: none",
        "",
        "servers: none",
        "",
        "bindings: none",
        "",
      ].join("\n"),
    );
    expect(report.config_exists).toBe(false);
    expect(report.context).toEqual({
      server: null,
      server_source: null,
      server_instead_of: null,
      server_name: null,
      server_unknown_name: false,
      token_source: null,
      token_profile: null,
      project: null,
      project_source: null,
    });
  });

  it("points at `todou login` when the server has no token stored", async () => {
    const env = {
      XDG_CONFIG_HOME: join(dir, "absent"),
      TODOU_SERVER: "https://todou.example",
    };
    const { human, report } = await show({ env });

    expect(human).toContain("  server: https://todou.example (TODOU_SERVER)");
    expect(human).toContain(
      "  token: none (run `todou login https://todou.example`)",
    );
    expect(report.context.token_source).toBeNull();
  });

  it("reports the alias a --server was rewritten from", async () => {
    // "Why is my server this one" is what this command answers, and a
    // --server that silently became another base needs to be visible.
    const env = seed("aliased", {
      default_server: "http://gateway.test/todou",
      servers: {
        "http://gateway.test/todou": {
          tokens: {},
          instead_of: ["https://todou.example"],
        },
      },
      bindings: [],
    });
    const { human, report } = await show({
      env: { ...env, TODOU_SERVER: "https://todou.example" },
    });

    expect(human).toContain(
      "  server: http://gateway.test/todou (TODOU_SERVER",
    );
    expect(human).toContain("via instead_of https://todou.example)");
    expect(human).toContain(
      "* http://gateway.test/todou — default token: none · profiles: none · " +
        "instead_of: https://todou.example",
    );
    expect(report.context.server_instead_of).toBe("https://todou.example");
    expect(report.servers[0]?.instead_of).toEqual(["https://todou.example"]);
  });

  it("prints no instead_of clause when there is nothing to say", async () => {
    // Both renderings, one assertion each: that the "unchanged when there
    // are no aliases" property holds is what keeps this from becoming noise
    // in every agent's `config show`.
    const env = seed("plain", TWO_SERVERS);
    const { human, report } = await show({ env });

    expect(human).not.toContain("instead_of");
    expect(report.context.server_instead_of).toBeNull();
    expect(report.servers.every((s) => s.instead_of.length === 0)).toBe(true);
  });

  it("lets an unknown --profile fail, and leaks nothing while failing", async () => {
    const env = seed("bad-profile", TWO_SERVERS);
    const result = await runCli(["config", "show", "--profile", "nope"], {
      env,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown profile "nope"');
    // The hint lists the profile *names*, which is the diagnosis; the
    // sweep is what proves it stops there.
    expect(result.stderr).toContain("available: claude-code, harness");
    assertNoSentinels(result.stdout + result.stderr);
  });
});

describe("the hint that replaces reading config.toml by hand", () => {
  // T-176 shut the door on hand-written curl; this is the sign on it.
  it("points an unconfigured command at config show", async () => {
    const result = await runCli(["whoami"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("todou config show");
  });

  it("points a logged-out command at config show", async () => {
    const result = await runCli(["whoami"], {
      env: { TODOU_SERVER: "http://stub.test" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("todou config show");
  });
});

describe("config show with names and fragments (T-366)", () => {
  /** A raw fragment file next to the seeded config.toml. */
  function writeFragment(
    env: Record<string, string>,
    name: string,
    body: string,
  ) {
    mkdirSync(join(String(env.XDG_CONFIG_HOME), "todou"), {
      recursive: true,
    });
    writeFileSync(join(String(env.XDG_CONFIG_HOME), "todou", name), body);
  }

  const NAMED: CliConfig = {
    // A name in default_server: the very spelling `via name` reports.
    default_server: "work",
    servers: {
      "http://198.51.100.7/todou": {
        name: "work",
        token: SENTINELS.default,
        tokens: {},
        instead_of: [],
      },
      "https://staging.example": {
        name: "home",
        tokens: { "bot-one": SENTINELS.other },
        instead_of: [],
      },
    },
    bindings: [],
  };

  it("renders the name on server lines and via name on the context line", async () => {
    const env = seed("named", NAMED);
    const { human, report } = await show({ env });

    expect(human).toContain(
      "* http://198.51.100.7/todou — name: work · default token: set · profiles: none",
    );
    expect(human).toContain(
      "  https://staging.example — name: home · default token: none · profiles: bot-one",
    );
    expect(human).toContain(
      "  server: http://198.51.100.7/todou (default_server, via name work)",
    );
    expect(report.context.server_name).toBe("work");
    expect(report.servers.map((s) => s.name)).toEqual(["work", "home"]);
  });

  it("lists every file in merge order and marks the write target", async () => {
    const env = seed("fragments", TWO_SERVERS);
    writeFragment(
      env,
      "config.10-work.toml",
      '[servers."http://198.51.100.7/todou"]\nname = "work"\n',
    );
    writeFragment(
      env,
      "config.20-home.toml",
      '[servers."https://staging.example"]\nname = "home"\n',
    );
    const { human, report } = await show({ env });

    expect(human).toContain("user config:");
    expect(human).toContain(
      `  ${join(String(env.XDG_CONFIG_HOME), "todou", "config.10-work.toml")}`,
    );
    expect(human).toContain(
      `  ${join(String(env.XDG_CONFIG_HOME), "todou", "config.20-home.toml")}`,
    );
    expect(human).toContain(`  ${configPath(env)} (write target)`);
    expect(report.config_files).toEqual([
      join(String(env.XDG_CONFIG_HOME), "todou", "config.10-work.toml"),
      join(String(env.XDG_CONFIG_HOME), "todou", "config.20-home.toml"),
      configPath(env),
    ]);
  });

  it("names the fragment a binding came from on the binding line", async () => {
    const remote = "git@git.example:org/repo.git";
    const env = seed("frag-binding", TWO_SERVERS);
    const fragment = join(
      String(env.XDG_CONFIG_HOME),
      "todou",
      "config.work.toml",
    );
    writeFragment(
      env,
      "config.work.toml",
      [
        "[[bindings]]",
        `remote = "${remote}"`,
        'server = "https://staging.example"',
        'project = "from-frag"',
        "",
      ].join("\n"),
    );
    const cwd = makeRepo("frag-bound", remote);
    const { human, report } = await show({ env, cwd });

    expect(human).toContain(
      `* ${remote} → https://staging.example · project from-frag · from ${displayPath(fragment, cwd)}`,
    );
    expect(report.bindings).toEqual([
      {
        remote,
        server: "https://staging.example",
        project: "from-frag",
        source: fragment,
        active: true,
      },
    ]);
  });

  it("prints the whole report around an unknown server name", async () => {
    // A name deleted from the config but still sitting in default_server:
    // the state that most needs this command, which must not fail on it.
    const env = {
      XDG_CONFIG_HOME: join(dir, "unknown-name"),
      TODOU_SERVER: "wrok",
    };
    mkdirSync(join(dir, "unknown-name", "todou"), { recursive: true });
    writeFileSync(
      configPath(env),
      [
        '[servers."http://198.51.100.7/todou"]',
        'name = "work"',
        `token = "${SENTINELS.default}"`,
        "",
      ].join("\n"),
    );
    const { human, report } = await show({ env });

    expect(human).toContain("  server: wrok (TODOU_SERVER)");
    expect(human).toContain(
      "unknown server name: wrok is not a URL and matches no name above",
    );
    expect(human).toContain("servers:");
    expect(human).toContain(
      "http://198.51.100.7/todou — name: work · default token: set",
    );
    expect(report.context.server_unknown_name).toBe(true);
    expect(report.context.server_name).toBeNull();
  });

  it("a real command fails readably on an unknown name", async () => {
    const env = {
      XDG_CONFIG_HOME: join(dir, "unknown-name-cmd"),
      TODOU_SERVER: "wrok",
    };
    mkdirSync(join(dir, "unknown-name-cmd", "todou"), { recursive: true });
    writeFileSync(
      configPath(env),
      [
        '[servers."http://198.51.100.7/todou"]',
        'name = "work"',
        `token = "${SENTINELS.default}"`,
        "",
      ].join("\n"),
    );
    const result = await runCli(["whoami"], { env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown server "wrok"');
    expect(result.stderr).toContain("known names: work");
    assertNoSentinels(result.stdout + result.stderr);
  });
});

describe("config show fragment fidelity (T-366 review)", () => {
  /** A raw fragment next to whatever else the case seeds. */
  function writeFragment(
    env: Record<string, string>,
    name: string,
    body: string,
  ) {
    mkdirSync(join(String(env.XDG_CONFIG_HOME), "todou"), {
      recursive: true,
    });
    writeFileSync(join(String(env.XDG_CONFIG_HOME), "todou", name), body);
  }

  it("lists a fragment when config.toml does not exist at all", async () => {
    const env = { XDG_CONFIG_HOME: join(dir, "frag-only") };
    const fragment = join(
      String(env.XDG_CONFIG_HOME),
      "todou",
      "config.10-work.toml",
    );
    writeFragment(
      env,
      "config.10-work.toml",
      [
        '[servers."http://198.51.100.7/todou"]',
        'name = "work"',
        `token = "${SENTINELS.default}"`,
        "",
      ].join("\n"),
    );
    const { human, report } = await show({ env });

    // The whole config comes from that one fragment; the header must say
    // so instead of a single "config.toml (not found)" line.
    expect(human).toContain("user config:");
    expect(human).toContain(`  ${fragment}`);
    expect(human).toContain(`  ${configPath(env)} (write target, not found)`);
    expect(human).not.toMatch(/user config: \S+ \(not found\)/);
    // config_files carries what was actually read; the missing write
    // target is a rendered line, not a phantom file.
    expect(report.config_files).toEqual([fragment]);
  });

  it("attributes each duplicate-remote row to its own file, stars the winner", async () => {
    const remote = "git@git.example:org/repo.git";
    const env = { XDG_CONFIG_HOME: join(dir, "dup-remote") };
    const fragment = join(
      String(env.XDG_CONFIG_HOME),
      "todou",
      "config.work.toml",
    );
    writeFragment(
      env,
      "config.work.toml",
      [
        "[[bindings]]",
        `remote = "${remote}"`,
        'server = "https://todou.example"',
        'project = "from-frag"',
        "",
      ].join("\n"),
    );
    writeFragment(
      env,
      "config.toml",
      [
        "[[bindings]]",
        `remote = "${remote}"`,
        'server = "https://todou.example"',
        'project = "from-own"',
        "",
      ].join("\n"),
    );
    const cwd = makeRepo("dup-bound", remote);
    const { human, report } = await show({ env, cwd });

    expect(human).toContain(
      `  ${remote} → https://todou.example · project from-frag · from ${displayPath(fragment, cwd)}`,
    );
    expect(human).toContain(
      `* ${remote} → https://todou.example · project from-own`,
    );
    // Exactly one starred binding row: the merged winner, not every row
    // that happens to share the remote.
    expect(
      human.split("\n").filter((l) => l.startsWith("* ") && l.includes("→"))
        .length,
    ).toBe(1);
    expect(report.bindings).toEqual([
      {
        remote,
        server: "https://todou.example",
        project: "from-frag",
        source: fragment,
        active: false,
      },
      {
        remote,
        server: "https://todou.example",
        project: "from-own",
        source: configPath(env),
        active: true,
      },
    ]);
  });
});
