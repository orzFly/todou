import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeFetch, runCli } from "./harness.ts";

const base = mkdtempSync(join(tmpdir(), "todou-cli-env-token-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const me = {
  id: 2,
  login: "claude-agent",
  display_name: "Agent",
  kind: "machine",
  owner: null,
};

const USER_CONFIG = `default_server = "https://todou.example"

[servers."https://todou.example"]
name = "home"
token = "todou_pat_stored"
instead_of = ["https://public.todou.example"]

[servers."https://other.test"]
token = "todou_pat_other"

[servers."https://other.test".tokens]
bot = "todou_pat_other_bot"

[[bindings]]
remote = "git@example.com:me/bound.git"
server = "https://other.test"
project = "bound"
`;

let counter = 0;

type Opts = { argv?: string[]; remote?: string; userConfig?: string };

/**
 * A checkout under a hermetic HOME holding the user's config, with the
 * given directory config committed into it — the shape of an agent running
 * inside a cloned PR.
 */
function checkout(
  dirToml: string | null,
  opts: Opts = {},
): {
  cwd: string;
  env: Record<string, string>;
} {
  const { remote, userConfig = USER_CONFIG } = opts;
  const home = join(base, `case-${counter++}`);
  const xdg = join(home, ".config");
  mkdirSync(join(xdg, "todou"), { recursive: true });
  writeFileSync(join(xdg, "todou", "config.toml"), userConfig);
  const cwd = join(home, "work", "repo");
  mkdirSync(cwd, { recursive: true });
  if (dirToml !== null) writeFileSync(join(cwd, ".todou.toml"), dirToml);
  if (remote !== undefined) {
    execFileSync("git", ["-C", cwd, "init", "-q"]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", remote]);
  }
  return { cwd, env: { HOME: home, XDG_CONFIG_HOME: xdg } };
}

/** Every request as host + bearer, the two things a leak is made of. */
async function whoami(
  dirToml: string | null,
  env: Record<string, string>,
  opts: Opts = {},
) {
  const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", me]]);
  const where = checkout(dirToml, opts);
  const result = await runCli(["whoami", ...(opts.argv ?? [])], {
    fetchImpl,
    cwd: where.cwd,
    env: { ...where.env, ...env },
  });
  const seen = calls.map((c) => ({
    origin: new URL(c.url).origin,
    auth: new Headers(c.init.headers).get("authorization"),
  }));
  return { ...result, seen };
}

const EVIL = 'project = "x"\nserver = "https://evil.example"\n';

describe("TODOU_TOKEN and a server named by a directory config (T-618)", () => {
  it("never sends TODOU_TOKEN to a server only the directory config named", async () => {
    const run = await whoami(EVIL, { TODOU_TOKEN: "todou_pat_victim" });
    expect(run.seen).toEqual([]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "TODOU_TOKEN is not sent to https://evil.example, which only ./.todou.toml names",
    );
    expect(run.stderr).toContain("TODOU_SERVER=https://evil.example");
  });

  it("config show says why no token is in use", async () => {
    const where = checkout(EVIL);
    const result = await runCli(["config", "show"], {
      cwd: where.cwd,
      env: { ...where.env, TODOU_TOKEN: "todou_pat_victim" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "TODOU_TOKEN is not sent to a server only a directory config names",
    );
    expect(result.stdout).not.toContain("todou_pat_victim");
  });

  it("a directory config naming a server the user has logged in to gets TODOU_TOKEN", async () => {
    const run = await whoami('project = "x"\nserver = "https://other.test"\n', {
      TODOU_TOKEN: "todou_pat_env",
    });
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://other.test", auth: "Bearer todou_pat_env" },
    ]);
  });

  // The setups below must keep working exactly as before.

  it("CI: TODOU_SERVER + TODOU_TOKEN outrank the directory config", async () => {
    const run = await whoami(EVIL, {
      TODOU_SERVER: "https://ci.test",
      TODOU_TOKEN: "todou_pat_ci",
    });
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://ci.test", auth: "Bearer todou_pat_ci" },
    ]);
  });

  it("CI: TODOU_SERVER naming the same server the directory config does", async () => {
    const run = await whoami(EVIL, {
      TODOU_SERVER: "https://evil.example",
      TODOU_TOKEN: "todou_pat_ci",
    });
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://evil.example", auth: "Bearer todou_pat_ci" },
    ]);
  });

  it("--server is the user's own word, like TODOU_SERVER", async () => {
    const run = await whoami(
      EVIL,
      { TODOU_TOKEN: "todou_pat_env" },
      { argv: ["--server", "https://evil.example"] },
    );
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://evil.example", auth: "Bearer todou_pat_env" },
    ]);
  });

  it("a directory config naming default_server still gets TODOU_TOKEN", async () => {
    const run = await whoami(
      'project = "todou"\nserver = "https://todou.example"\n',
      { TODOU_TOKEN: "todou_pat_env" },
    );
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://todou.example", auth: "Bearer todou_pat_env" },
    ]);
  });

  it("…even when default_server has no entry of its own", async () => {
    // Never logged in: TODOU_TOKEN is the only credential, default_server
    // the only word on where it goes.
    const run = await whoami(
      'project = "x"\nserver = "https://bare.test"\n',
      { TODOU_TOKEN: "todou_pat_env" },
      { userConfig: 'default_server = "https://bare.test"\n' },
    );
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://bare.test", auth: "Bearer todou_pat_env" },
    ]);
  });

  it("…including when it writes default_server at an instead_of alias", async () => {
    const run = await whoami(
      'project = "todou"\nserver = "https://public.todou.example"\n',
      { TODOU_TOKEN: "todou_pat_env" },
    );
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://todou.example", auth: "Bearer todou_pat_env" },
    ]);
  });

  it("…or by the server's name", async () => {
    const run = await whoami('project = "todou"\nserver = "home"\n', {
      TODOU_TOKEN: "todou_pat_env",
    });
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://todou.example", auth: "Bearer todou_pat_env" },
    ]);
  });

  it("a directory config without a server key floats onto default_server", async () => {
    const run = await whoami('project = "todou"\n', {
      TODOU_TOKEN: "todou_pat_env",
    });
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://todou.example", auth: "Bearer todou_pat_env" },
    ]);
  });

  it("a git binding in the user's own config still gets TODOU_TOKEN", async () => {
    const run = await whoami(
      null,
      { TODOU_TOKEN: "todou_pat_env" },
      { remote: "git@example.com:me/bound.git" },
    );
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://other.test", auth: "Bearer todou_pat_env" },
    ]);
  });

  it("a stored token is already bound to its own server", async () => {
    const run = await whoami(
      'project = "x"\nserver = "https://other.test"\n',
      {},
    );
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://other.test", auth: "Bearer todou_pat_other" },
    ]);
  });

  it("--profile picks that server's stored profile, TODOU_TOKEN or not", async () => {
    const run = await whoami(
      'project = "x"\nserver = "https://other.test"\n',
      { TODOU_TOKEN: "todou_pat_env" },
      { argv: ["--profile", "bot"] },
    );
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://other.test", auth: "Bearer todou_pat_other_bot" },
    ]);
  });

  it("TODOU_PROFILE does the same", async () => {
    const run = await whoami('project = "x"\nserver = "https://other.test"\n', {
      TODOU_PROFILE: "bot",
    });
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { origin: "https://other.test", auth: "Bearer todou_pat_other_bot" },
    ]);
  });
});
