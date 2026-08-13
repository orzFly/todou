import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliConfig } from "../src/config.ts";
import { configPath, loadCliConfig } from "../src/config.ts";
import { resolveContext } from "../src/context.ts";
import { CliError } from "../src/errors.ts";
import { fakeFetch, runCli } from "./harness.ts";

const config: CliConfig = {
  default_server: "http://stub.test",
  servers: {
    "http://stub.test": {
      token: "todou_pat_default",
      tokens: {
        "claude-code": "todou_pat_claude",
        ci: "todou_pat_ci",
      },
    },
  },
  bindings: [],
};

function resolve(overrides: {
  profile?: string;
  env?: Record<string, string>;
}) {
  return resolveContext({
    flags: { profile: overrides.profile },
    env: overrides.env ?? {},
    config,
    remoteUrl: null,
  });
}

describe("token selection matrix", () => {
  it("--profile beats TODOU_TOKEN", () => {
    const ctx = resolve({
      profile: "ci",
      env: { TODOU_TOKEN: "todou_pat_env" },
    });
    expect(ctx.token).toBe("todou_pat_ci");
    expect(ctx.tokenSource).toBe("flag-profile");
    expect(ctx.tokenProfile).toBe("ci");
  });

  it("TODOU_TOKEN beats TODOU_PROFILE and the auto rule", () => {
    const ctx = resolve({
      env: {
        TODOU_TOKEN: "todou_pat_env",
        TODOU_PROFILE: "ci",
        CLAUDECODE: "1",
      },
    });
    expect(ctx.token).toBe("todou_pat_env");
    expect(ctx.tokenSource).toBe("env-token");
  });

  it("TODOU_PROFILE beats the auto rule", () => {
    const ctx = resolve({ env: { TODOU_PROFILE: "ci", CLAUDECODE: "1" } });
    expect(ctx.token).toBe("todou_pat_ci");
    expect(ctx.tokenSource).toBe("env-profile");
  });

  it("CLAUDECODE=1 auto-selects the claude-code profile", () => {
    const ctx = resolve({ env: { CLAUDECODE: "1" } });
    expect(ctx.token).toBe("todou_pat_claude");
    expect(ctx.tokenSource).toBe("auto-harness");
    expect(ctx.tokenProfile).toBe("claude-code");
  });

  it("a hermes turn auto-selects the hermes-agent profile", () => {
    const ctx = resolveContext({
      flags: {},
      env: { HERMES_SESSION_KEY: "agent:main:telegram:dm:1000001" },
      config: {
        default_server: "http://stub.test",
        servers: {
          "http://stub.test": {
            token: "todou_pat_default",
            tokens: { "hermes-agent": "todou_pat_hermes" },
          },
        },
        bindings: [],
      },
      remoteUrl: null,
    });
    expect(ctx.token).toBe("todou_pat_hermes");
    expect(ctx.tokenSource).toBe("auto-harness");
    expect(ctx.tokenProfile).toBe("hermes-agent");
  });

  it("a hermes turn without a hermes-agent profile falls back to default", () => {
    const ctx = resolve({
      env: { HERMES_SESSION_KEY: "agent:main:telegram:dm:1000001" },
    });
    expect(ctx.token).toBe("todou_pat_default");
    expect(ctx.tokenSource).toBe("default");
  });

  it("CLAUDECODE=1 without a claude-code profile falls back to default", () => {
    const ctx = resolveContext({
      flags: {},
      env: { CLAUDECODE: "1" },
      config: {
        default_server: "http://stub.test",
        servers: {
          "http://stub.test": { token: "todou_pat_default", tokens: {} },
        },
        bindings: [],
      },
      remoteUrl: null,
    });
    expect(ctx.token).toBe("todou_pat_default");
    expect(ctx.tokenSource).toBe("default");
  });

  it('"default" is reserved and bypasses the auto rule', () => {
    const ctx = resolve({ profile: "default", env: { CLAUDECODE: "1" } });
    expect(ctx.token).toBe("todou_pat_default");
    expect(ctx.tokenSource).toBe("default");
  });

  it("unknown profiles fail loudly with the available names", () => {
    expect(() => resolve({ profile: "nope" })).toThrow(CliError);
    const err = (() => {
      try {
        resolve({ profile: "nope" });
      } catch (e) {
        return e as CliError;
      }
      return undefined;
    })();
    expect(err?.hint).toContain("claude-code");
    expect(err?.hint).toContain("ci");
  });

  it("no profile machinery runs without a server", () => {
    const ctx = resolveContext({
      flags: { profile: "ci" },
      env: {},
      config: { servers: {}, bindings: [] },
      remoteUrl: null,
    });
    expect(ctx.server).toBeUndefined();
    expect(ctx.tokenSource).toBeNull();
  });
});

describe("config compatibility and login --profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-profiles-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a pre-profiles config file", () => {
    const env = { XDG_CONFIG_HOME: join(dir, "old") };
    mkdirSync(join(dir, "old", "todou"), { recursive: true });
    writeFileSync(
      configPath(env),
      'default_server = "http://stub.test"\n[servers."http://stub.test"]\ntoken = "todou_pat_old"\n',
    );
    const loaded = loadCliConfig(env);
    expect(loaded.servers["http://stub.test"]).toEqual({
      token: "todou_pat_old",
      tokens: {},
    });
  });

  it("login --profile stores a named token next to the default", async () => {
    const me = {
      id: 2,
      login: "claude",
      display_name: "Claude",
      kind: "machine",
      owner: null,
    };
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const env = { XDG_CONFIG_HOME: join(dir, "login") };

    const first = await runCli(["login", "http://stub.test", "--manual"], {
      fetchImpl,
      env,
      stdinText: "todou_pat_default\n",
    });
    expect(first.exitCode).toBe(0);

    const second = await runCli(
      ["login", "http://stub.test", "--manual", "--profile", "claude-code"],
      { fetchImpl, env, stdinText: "todou_pat_claude\n" },
    );
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toContain('profile "claude-code"');

    const loaded = loadCliConfig(env);
    expect(loaded.servers["http://stub.test"]).toEqual({
      token: "todou_pat_default",
      tokens: { "claude-code": "todou_pat_claude" },
    });
  });

  it("login rejects the reserved profile name", async () => {
    const result = await runCli(
      ["login", "http://stub.test", "--manual", "--profile", "default"],
      { env: { XDG_CONFIG_HOME: join(dir, "reserved") } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reserved");
  });

  it("whoami reports the auto-selected profile on stderr", async () => {
    const me = {
      id: 2,
      login: "claude",
      display_name: "Claude",
      kind: "machine",
      owner: null,
    };
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const env = { XDG_CONFIG_HOME: join(dir, "whoami") };
    await runCli(
      ["login", "http://stub.test", "--manual", "--profile", "claude-code"],
      { fetchImpl, env, stdinText: "todou_pat_claude\n" },
    );
    const result = await runCli(["whoami"], {
      fetchImpl,
      env: { ...env, CLAUDECODE: "1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      'token: profile "claude-code" (auto-detected harness)',
    );
    expect(result.stderr).toContain("detected harness: claude-code");
  });
});
