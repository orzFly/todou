import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configPath, loadCliConfig, saveCliConfig } from "../src/config.ts";
import { followAdvice } from "../src/follow-advice.ts";
import { runCli } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "todou-agent-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SOCKET = "/run/cc-socks/4242.sock";

/** What the command should print for a situation, rendered as it renders. */
function expected(input: Parameters<typeof followAdvice>[0]): string {
  return `${followAdvice(input).paragraphs.join("\n\n")}\n`;
}

async function canIFollow(env: Record<string, string | undefined>) {
  const result = await runCli(["agent", "can-i-follow"], { env });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("agent can-i-follow", () => {
  it("offers uds under Claude Code with a socket", async () => {
    const stdout = await canIFollow({
      CLAUDECODE: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
    });
    expect(stdout).toBe(
      expected({ harness: "claude-code", socket: SOCKET, optedOut: false }),
    );
    expect(stdout).toContain("`--follow=uds` is available");
  });

  it("reports the missing socket under Claude Code without one", async () => {
    const stdout = await canIFollow({ CLAUDECODE: "1" });
    expect(stdout).toBe(
      expected({
        harness: "claude-code",
        socket: undefined,
        optedOut: false,
      }),
    );
    expect(stdout).toContain("CLAUDE_CODE_MESSAGING_SOCKET is not set");
  });

  it("names another harness it cannot answer for", async () => {
    const stdout = await canIFollow({ CODEX_THREAD_ID: "t-1" });
    expect(stdout).toBe(
      expected({ harness: "codex", socket: undefined, optedOut: false }),
    );
    expect(stdout).toContain("running under Codex");
  });

  it("answers with no harness at all", async () => {
    const stdout = await canIFollow({});
    expect(stdout).toBe(
      expected({ harness: null, socket: undefined, optedOut: false }),
    );
    expect(stdout).toContain("no agent harness detected");
  });

  it("never names either side of the opt-out, in any situation", async () => {
    // The escalation belongs to `--follow=uds`'s own failure, where it is
    // actionable; the way back out belongs to the person who opted out. An
    // agent meeting either one here would be a turn away from running it.
    const optedOut = { XDG_CONFIG_HOME: join(dir, "no-disclosure") };
    await runCli(["agent", "opt-out-uds"], { env: optedOut });
    for (const env of [
      { CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
      { CLAUDECODE: "1" },
      { CODEX_THREAD_ID: "t-1" },
      {},
      { ...optedOut, CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_SOCKET: SOCKET },
    ]) {
      const stdout = await canIFollow(env);
      expect(stdout).not.toContain("opt-out-uds");
      expect(stdout).not.toContain("opt-in-uds");
    }
  });
});

describe("agent opt-out-uds / opt-in-uds", () => {
  it("writes the switch, stops the advice, and takes it back", async () => {
    const env = { XDG_CONFIG_HOME: join(dir, "round-trip") };
    const udsEnv = {
      ...env,
      CLAUDECODE: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
    };

    const out = await runCli(["agent", "opt-out-uds"], { env });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("--follow=uds opted out");
    // The one place an agent must not read it is `can-i-follow`; the person
    // who just ran this is exactly who the way back is for.
    expect(out.stdout).toContain("todou agent opt-in-uds");
    expect(readFileSync(configPath(env), "utf8")).toContain(
      "follow_uds = false",
    );

    expect(await canIFollow(udsEnv)).toBe(
      expected({ harness: "claude-code", socket: SOCKET, optedOut: true }),
    );

    const back = await runCli(["agent", "opt-in-uds"], { env });
    expect(back.exitCode).toBe(0);
    expect(back.stdout).toContain("--follow=uds advised again");
    // Removed, not set to `true`: every `todou login` rewrites this file.
    expect(readFileSync(configPath(env), "utf8")).not.toContain("follow_uds");

    expect(await canIFollow(udsEnv)).toBe(
      expected({ harness: "claude-code", socket: SOCKET, optedOut: false }),
    );
  });

  it("leaves the file alone when it is already in that state", async () => {
    const env = { XDG_CONFIG_HOME: join(dir, "idempotent") };

    await runCli(["agent", "opt-out-uds"], { env });
    const before = readFileSync(configPath(env), "utf8");
    const again = await runCli(["agent", "opt-out-uds"], { env });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("was already opted out");
    expect(readFileSync(configPath(env), "utf8")).toBe(before);

    await runCli(["agent", "opt-in-uds"], { env });
    const advised = await runCli(["agent", "opt-in-uds"], { env });
    expect(advised.exitCode).toBe(0);
    expect(advised.stdout).toContain("was already advised");
  });

  it("keeps every other part of the config across both writes", async () => {
    // The switch shares a file with the stored tokens, and `saveCliConfig`
    // rewrites the whole document each time.
    const env = { XDG_CONFIG_HOME: join(dir, "preserves") };
    const seeded = {
      default_server: "https://todou.example",
      servers: {
        "https://todou.example": {
          token: "FAKE_H4RQ7XNM2VZB9KTC",
          tokens: { "claude-code": "FAKE_D6WJY3PLS8XGQF5N" },
        },
      },
      bindings: [
        {
          remote: "git@git.example:org/repo.git",
          server: "https://todou.example",
          project: "todou",
        },
      ],
    };
    saveCliConfig(seeded, env);

    await runCli(["agent", "opt-out-uds"], { env });
    expect(loadCliConfig(env)).toEqual({
      ...seeded,
      agent: { follow_uds: false },
    });

    await runCli(["agent", "opt-in-uds"], { env });
    expect(loadCliConfig(env)).toEqual(seeded);
    expect(readFileSync(configPath(env), "utf8")).not.toContain("[agent]");
  });
});
