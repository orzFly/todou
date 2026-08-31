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
    },
    "https://staging.example": { tokens: { "bot-one": SENTINELS.other } },
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

    // Same job, same rule: `toEqual`, never `toMatchObject`.
    expect(report).toEqual({
      version: "0.0.0-test",
      config_path: configPath(env),
      config_exists: true,
      dir_config: null,
      git_remote: null,
      context: {
        server: "https://todou.example",
        server_source: "default_server",
        token_source: "default",
        token_profile: null,
        project: null,
        project_source: null,
      },
      servers: [
        {
          origin: "https://staging.example",
          active: false,
          default_token: false,
          profiles: ["bot-one"],
        },
        {
          origin: "https://todou.example",
          active: true,
          default_token: true,
          profiles: ["claude-code", "harness"],
        },
      ],
      bindings: [],
    });
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
        "https://todou.example": { token: SENTINELS.default, tokens: {} },
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
    expect(report.git_remote).toBe(remote);
    expect(report.bindings[0]?.active).toBe(false);
    expect(report.servers).toEqual([
      {
        origin: "https://todou.example",
        active: true,
        default_token: true,
        profiles: [],
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
