import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACT_AS_HEADER, AGENT_CONTEXT_HEADER } from "@todou/shared";
import { afterAll, describe, expect, it } from "vitest";
import type { CliConfig } from "../src/config.ts";
import { configPath, loadCliConfig, saveCliConfig } from "../src/config.ts";
import { resolveContext } from "../src/context.ts";
import { CliError } from "../src/errors.ts";
import { type Captured, fakeFetch, runCli } from "./harness.ts";

const config: CliConfig = {
  default_server: "http://stub.test",
  servers: {
    "http://stub.test": {
      token: "todou_pat_default",
      tokens: {
        "claude-code": "todou_pat_claude",
        ci: "todou_pat_ci",
      },
      instead_of: [],
    },
  },
  bindings: [],
};

/** Same server, plus the shared profile every harness falls back to. */
const shared: CliConfig = {
  default_server: "http://stub.test",
  servers: {
    "http://stub.test": {
      token: "todou_pat_default",
      tokens: {
        "claude-code": "todou_pat_claude",
        harness: "todou_pat_harness",
      },
      instead_of: [],
    },
  },
  bindings: [],
};

function resolve(overrides: {
  profile?: string;
  env?: Record<string, string>;
  config?: CliConfig;
}) {
  return resolveContext({
    flags: { profile: overrides.profile },
    env: overrides.env ?? {},
    config: overrides.config ?? config,
    remoteUrl: null,
    dirConfig: null,
  });
}

const HERMES_ENV = { HERMES_SESSION_KEY: "agent:main:telegram:dm:1000001" };

describe("token selection matrix", () => {
  it("--profile beats TODOU_TOKEN", async () => {
    const ctx = await resolve({
      profile: "ci",
      env: { TODOU_TOKEN: "todou_pat_env" },
    });
    expect(ctx.token).toBe("todou_pat_ci");
    expect(ctx.tokenSource).toBe("flag-profile");
    expect(ctx.tokenProfile).toBe("ci");
  });

  it("TODOU_TOKEN beats TODOU_PROFILE and the auto rule", async () => {
    const ctx = await resolve({
      env: {
        TODOU_TOKEN: "todou_pat_env",
        TODOU_PROFILE: "ci",
        CLAUDECODE: "1",
      },
    });
    expect(ctx.token).toBe("todou_pat_env");
    expect(ctx.tokenSource).toBe("env-token");
  });

  it("TODOU_PROFILE beats the auto rule", async () => {
    const ctx = await resolve({
      env: { TODOU_PROFILE: "ci", CLAUDECODE: "1" },
    });
    expect(ctx.token).toBe("todou_pat_ci");
    expect(ctx.tokenSource).toBe("env-profile");
  });

  it("CLAUDECODE=1 auto-selects the claude-code profile", async () => {
    const ctx = await resolve({ env: { CLAUDECODE: "1" } });
    expect(ctx.token).toBe("todou_pat_claude");
    expect(ctx.tokenSource).toBe("auto-harness");
    expect(ctx.tokenProfile).toBe("claude-code");
  });

  it("a hermes turn auto-selects the hermes-agent profile", async () => {
    const ctx = await resolveContext({
      flags: {},
      env: HERMES_ENV,
      config: {
        default_server: "http://stub.test",
        servers: {
          "http://stub.test": {
            token: "todou_pat_default",
            tokens: { "hermes-agent": "todou_pat_hermes" },
            instead_of: [],
          },
        },
        bindings: [],
      },
      remoteUrl: null,
      dirConfig: null,
    });
    expect(ctx.token).toBe("todou_pat_hermes");
    expect(ctx.tokenSource).toBe("auto-harness");
    expect(ctx.tokenProfile).toBe("hermes-agent");
  });

  it("a hermes turn without a hermes-agent profile falls back to default", async () => {
    const ctx = await resolve({ env: HERMES_ENV });
    expect(ctx.token).toBe("todou_pat_default");
    expect(ctx.tokenSource).toBe("default");
  });

  it('"harness" covers a harness with no profile of its own', async () => {
    const ctx = await resolve({ env: HERMES_ENV, config: shared });
    expect(ctx.token).toBe("todou_pat_harness");
    expect(ctx.tokenSource).toBe("auto-harness-shared");
    expect(ctx.tokenProfile).toBe("harness");
  });

  it('a harness-named profile beats "harness"', async () => {
    const ctx = await resolve({ env: { CLAUDECODE: "1" }, config: shared });
    expect(ctx.token).toBe("todou_pat_claude");
    expect(ctx.tokenSource).toBe("auto-harness");
    expect(ctx.tokenProfile).toBe("claude-code");
  });

  it('"harness" stays inert outside a harness', async () => {
    const ctx = await resolve({ env: {}, config: shared });
    expect(ctx.token).toBe("todou_pat_default");
    expect(ctx.tokenSource).toBe("default");
  });

  it('"default" and TODOU_TOKEN both bypass "harness"', async () => {
    const explicit = await resolve({
      profile: "default",
      env: HERMES_ENV,
      config: shared,
    });
    expect(explicit.token).toBe("todou_pat_default");
    expect(explicit.tokenSource).toBe("default");

    const fromEnv = await resolve({
      env: { ...HERMES_ENV, TODOU_TOKEN: "todou_pat_env" },
      config: shared,
    });
    expect(fromEnv.token).toBe("todou_pat_env");
    expect(fromEnv.tokenSource).toBe("env-token");
  });

  it("--profile harness works outside a harness too", async () => {
    const ctx = await resolve({ profile: "harness", env: {}, config: shared });
    expect(ctx.token).toBe("todou_pat_harness");
    expect(ctx.tokenSource).toBe("flag-profile");
    expect(ctx.tokenProfile).toBe("harness");
  });

  it("CLAUDECODE=1 without a claude-code profile falls back to default", async () => {
    const ctx = await resolveContext({
      flags: {},
      env: { CLAUDECODE: "1" },
      config: {
        default_server: "http://stub.test",
        servers: {
          "http://stub.test": {
            token: "todou_pat_default",
            tokens: {},
            instead_of: [],
          },
        },
        bindings: [],
      },
      remoteUrl: null,
      dirConfig: null,
    });
    expect(ctx.token).toBe("todou_pat_default");
    expect(ctx.tokenSource).toBe("default");
  });

  it('"default" is reserved and bypasses the auto rule', async () => {
    const ctx = await resolve({ profile: "default", env: { CLAUDECODE: "1" } });
    expect(ctx.token).toBe("todou_pat_default");
    expect(ctx.tokenSource).toBe("default");
  });

  it("unknown profiles fail loudly with the available names", async () => {
    await expect(resolve({ profile: "nope" })).rejects.toThrow(CliError);
    const err = await (async () => {
      try {
        await resolve({ profile: "nope" });
      } catch (e) {
        return e as CliError;
      }
      return undefined;
    })();
    expect(err?.hint).toContain("claude-code");
    expect(err?.hint).toContain("ci");
  });

  it("no profile machinery runs without a server", async () => {
    const ctx = await resolveContext({
      flags: { profile: "ci" },
      env: {},
      config: { servers: {}, bindings: [] },
      remoteUrl: null,
      dirConfig: null,
    });
    expect(ctx.server).toBeUndefined();
    expect(ctx.tokenSource).toBeNull();
  });
});

describe("config compatibility and login --profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-profiles-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a pre-profiles config file", async () => {
    const env = { XDG_CONFIG_HOME: join(dir, "old") };
    mkdirSync(join(dir, "old", "todou"), { recursive: true });
    writeFileSync(
      configPath(env),
      'default_server = "http://stub.test"\n[servers."http://stub.test"]\ntoken = "todou_pat_old"\n',
    );
    const loaded = await loadCliConfig(env);
    expect(loaded.servers["http://stub.test"]).toEqual({
      token: "todou_pat_old",
      tokens: {},
      instead_of: [],
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

    const loaded = await loadCliConfig(env);
    expect(loaded.servers["http://stub.test"]).toEqual({
      token: "todou_pat_default",
      tokens: { "claude-code": "todou_pat_claude" },
      instead_of: [],
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

  it("login --profile harness stores the shared profile whoami reports", async () => {
    const me = {
      id: 3,
      login: "fleet",
      display_name: "Fleet",
      kind: "machine",
      owner: null,
    };
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const env = { XDG_CONFIG_HOME: join(dir, "harness") };
    const login = await runCli(
      ["login", "http://stub.test", "--manual", "--profile", "harness"],
      { fetchImpl, env, stdinText: "todou_pat_fleet\n" },
    );
    expect(login.exitCode).toBe(0);
    expect(
      (await loadCliConfig(env)).servers["http://stub.test"]?.tokens,
    ).toEqual({
      harness: "todou_pat_fleet",
    });

    const result = await runCli(["whoami"], {
      fetchImpl,
      env: { ...env, CLAUDECODE: "1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      'token: profile "harness" (auto-detected harness, no profile of its own)',
    );
    expect(result.stderr).toContain("detected harness: claude-code");
  });
});

/** Profiles that act as an agent with a borrowed or their own token (T-693). */
describe("act-as profiles", () => {
  const actAs: CliConfig = {
    default_server: "http://stub.test",
    servers: {
      "http://stub.test": {
        token: "todou_pat_default",
        tokens: {
          ci: "todou_pat_ci",
          "claude-code": { act_as: "claude-agent" },
          harness: { act_as: "bot-one" },
          own: { act_as: "bot-two", token: "todou_pat_own" },
        },
        instead_of: [],
      },
    },
    bindings: [],
  };
  const withoutDefault: CliConfig = {
    ...actAs,
    servers: {
      "http://stub.test": {
        tokens: { harness: { act_as: "bot-one" } },
        instead_of: [],
      },
    },
  };

  it("borrows the default token on every path that picks a profile", async () => {
    const flag = await resolve({ profile: "harness", config: actAs });
    expect(flag).toMatchObject({
      token: "todou_pat_default",
      tokenSource: "flag-profile",
      tokenProfile: "harness",
      actAs: "bot-one",
    });
    const env = await resolve({
      env: { TODOU_PROFILE: "harness" },
      config: actAs,
    });
    expect(env).toMatchObject({
      token: "todou_pat_default",
      tokenSource: "env-profile",
      actAs: "bot-one",
    });
    const own = await resolve({ env: { CLAUDECODE: "1" }, config: actAs });
    expect(own).toMatchObject({
      token: "todou_pat_default",
      tokenSource: "auto-harness",
      tokenProfile: "claude-code",
      actAs: "claude-agent",
    });
    const sharedHarness = await resolve({ env: HERMES_ENV, config: actAs });
    expect(sharedHarness).toMatchObject({
      token: "todou_pat_default",
      tokenSource: "auto-harness-shared",
      tokenProfile: "harness",
      actAs: "bot-one",
    });
  });

  it("uses the profile's own token when it has one", async () => {
    expect(await resolve({ profile: "own", config: actAs })).toMatchObject({
      token: "todou_pat_own",
      actAs: "bot-two",
    });
  });

  it("leaves string profiles and the default token without act_as", async () => {
    expect(
      (await resolve({ profile: "ci", config: actAs })).actAs,
    ).toBeUndefined();
    expect((await resolve({ config: actAs })).actAs).toBeUndefined();
  });

  it("refuses to borrow a default token that is not stored", async () => {
    let err: CliError | undefined;
    try {
      await resolve({ profile: "harness", config: withoutDefault });
    } catch (e) {
      err = e as CliError;
    }
    expect(err).toBeInstanceOf(CliError);
    expect(err?.message).toBe(
      'profile "harness" acts as "bot-one" with the default token, but none is stored',
    );
    expect(err?.hint).toBe("run `todou login http://stub.test`");
  });

  describe("on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "todou-act-as-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const write = (name: string, body: string) => {
      const env = { XDG_CONFIG_HOME: join(dir, name) };
      mkdirSync(join(dir, name, "todou"), { recursive: true });
      writeFileSync(configPath(env), body);
      return env;
    };
    const seeded = async (name: string, config: CliConfig = actAs) => {
      const env = { XDG_CONFIG_HOME: join(dir, name) };
      await saveCliConfig(config, env);
      return env;
    };
    const agentMe = {
      id: 9,
      login: "bot-one",
      display_name: "bot-one",
      kind: "machine",
      owner: { id: 1, login: "user" },
    };
    const header = (call: Captured | undefined, name: string) =>
      call ? new Headers(call.init.headers).get(name) : undefined;
    const meCall = (calls: Captured[]) =>
      calls.find((c) => new URL(c.url).pathname === "/api/me");

    it("reads both profile forms, written inline or as a table", async () => {
      const env = write(
        "forms",
        [
          '[servers."http://stub.test"]',
          'token = "todou_pat_default"',
          '[servers."http://stub.test".tokens]',
          'ci = "todou_pat_ci"',
          'claude-code = { act_as = "claude-agent" }',
          '[servers."http://stub.test".tokens.harness]',
          'act_as = "bot-one"',
          'token = "todou_pat_own"',
          "",
        ].join("\n"),
      );
      expect(
        (await loadCliConfig(env)).servers["http://stub.test"]?.tokens,
      ).toEqual({
        ci: "todou_pat_ci",
        "claude-code": { act_as: "claude-agent" },
        harness: { act_as: "bot-one", token: "todou_pat_own" },
      });
    });

    it("rejects a table without act_as, or with a login no account can have", async () => {
      for (const [name, value] of [
        ["missing", '{ token = "todou_pat_own" }'],
        ["upper", '{ act_as = "Bot-One" }'],
        ["reserved", '{ act_as = "me" }'],
      ]) {
        const env = write(
          `bad-${name}`,
          `[servers."http://stub.test".tokens]\nharness = ${value}\n`,
        );
        await expect(loadCliConfig(env), name).rejects.toThrow(
          /invalid config/,
        );
      }
    });

    it("writes a table profile back so it reads the same", async () => {
      const env = await seeded("round-trip");
      expect(
        (await loadCliConfig(env)).servers["http://stub.test"]?.tokens,
      ).toEqual(actAs.servers["http://stub.test"]?.tokens);
    });

    it("sends the header on REST requests beside the agent context", async () => {
      const env = await seeded("rest");
      const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", agentMe]]);
      const result = await runCli(["whoami"], {
        fetchImpl,
        env: { ...env, HERMES_SESSION_KEY: HERMES_ENV.HERMES_SESSION_KEY },
      });
      expect(result.exitCode).toBe(0);
      const call = meCall(calls);
      expect(header(call, ACT_AS_HEADER)).toBe("bot-one");
      expect(header(call, AGENT_CONTEXT_HEADER)).not.toBeNull();
      expect(header(call, "authorization")).toBe("Bearer todou_pat_default");
      expect(result.stderr).toContain(
        'token: profile "harness" (auto-detected harness, no profile of its own), acting as bot-one',
      );
    });

    it("sends no header for a string profile", async () => {
      const env = await seeded("plain");
      const { fetchImpl, calls } = fakeFetch([
        ["GET", "/api/me", { ...agentMe, login: "user", kind: "human" }],
      ]);
      const result = await runCli(["whoami", "--profile", "ci"], {
        fetchImpl,
        env,
      });
      expect(result.exitCode).toBe(0);
      expect(header(meCall(calls), ACT_AS_HEADER)).toBeNull();
      expect(result.stderr).not.toContain("acting as");
    });

    describe("login --act-as", () => {
      const human = { ...agentMe, id: 1, login: "user", kind: "human" };

      it("stores only the profile, after the server accepts it", async () => {
        const env = await seeded("login-ok", {
          ...actAs,
          servers: {
            "http://stub.test": {
              token: "todou_pat_default",
              tokens: { ci: "todou_pat_ci" },
              instead_of: [],
            },
          },
        });
        const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", agentMe]]);
        const result = await runCli(
          [
            "login",
            "http://stub.test",
            "--profile",
            "harness",
            "--act-as",
            "bot-one",
          ],
          { fetchImpl, env },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe(
          'logged in to http://stub.test as bot-one (profile "harness", acting as bot-one with the default token)\n',
        );
        expect(header(meCall(calls), ACT_AS_HEADER)).toBe("bot-one");
        expect(calls).toHaveLength(1);
        expect((await loadCliConfig(env)).servers["http://stub.test"]).toEqual({
          token: "todou_pat_default",
          tokens: { ci: "todou_pat_ci", harness: { act_as: "bot-one" } },
          instead_of: [],
        });
      });

      it("leaves the file untouched when the server refuses", async () => {
        const env = await seeded("login-refused");
        const before = readFileSync(configPath(env));
        const { fetchImpl } = fakeFetch([
          [
            "GET",
            "/api/me",
            {
              __status: 401,
              body: {
                error: {
                  code: "unauthorized",
                  message: "this token cannot act as an agent",
                },
              },
            },
          ],
        ]);
        const result = await runCli(
          [
            "login",
            "http://stub.test",
            "--profile",
            "x",
            "--act-as",
            "bot-one",
          ],
          { fetchImpl, env },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("this token cannot act as an agent");
        expect(readFileSync(configPath(env)).equals(before)).toBe(true);
      });

      it("refuses a server that ignores the header and answers as the owner", async () => {
        const env = await seeded("login-ignored");
        const before = readFileSync(configPath(env));
        const { fetchImpl } = fakeFetch([["GET", "/api/me", human]]);
        const result = await runCli(
          [
            "login",
            "http://stub.test",
            "--profile",
            "x",
            "--act-as",
            "bot-one",
          ],
          { fetchImpl, env },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "http://stub.test answered as user, not bot-one; nothing was saved",
        );
        expect(result.stderr).toContain("0.6.8 or later");
        expect(result.stderr).not.toContain("logged in");
        expect(readFileSync(configPath(env)).equals(before)).toBe(true);
      });

      it("needs a stored default token, and --profile", async () => {
        const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", human]]);
        const bare = await runCli(
          [
            "login",
            "http://stub.test",
            "--profile",
            "x",
            "--act-as",
            "bot-one",
          ],
          { fetchImpl, env: await seeded("login-bare", withoutDefault) },
        );
        expect(bare.exitCode).toBe(1);
        expect(bare.stderr).toContain(
          "no default token stored for http://stub.test",
        );

        const noProfile = await runCli(
          ["login", "http://stub.test", "--act-as", "bot-one"],
          { fetchImpl, env: await seeded("login-no-profile") },
        );
        expect(noProfile.exitCode).toBe(1);
        expect(noProfile.stderr).toContain("--act-as needs --profile");

        const manual = await runCli(
          [
            "login",
            "http://stub.test",
            "--profile",
            "x",
            "--act-as",
            "bot-one",
            "--manual",
          ],
          { fetchImpl, env: await seeded("login-manual") },
        );
        expect(manual.exitCode).toBe(1);
        expect(manual.stderr).toContain(
          "--act-as cannot be combined with --manual or --no-browser",
        );
        expect(calls).toHaveLength(0);
      });
    });
  });
});
