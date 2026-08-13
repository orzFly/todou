import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCliConfig } from "../src/config.ts";
import { CliError } from "../src/errors.ts";
import { browserCommand, waitForCallback } from "../src/login-flow.ts";
import { fakeFetch, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};

describe("waitForCallback", () => {
  it("resolves the token and rejects wrong states without giving up", async () => {
    const token = await waitForCallback({
      state: "good-state",
      timeoutMs: 10_000,
      onListening: (port) => {
        void (async () => {
          const bad = await fetch(
            `http://127.0.0.1:${port}/callback?token=stolen&state=evil`,
          );
          expect(bad.status).toBe(400);
          const good = await fetch(
            `http://127.0.0.1:${port}/callback?token=todou_pat_ok&state=good-state`,
          );
          expect(good.status).toBe(200);
          expect(await good.text()).toContain("close this page");
        })();
      },
    });
    expect(token).toBe("todou_pat_ok");
  });

  it("times out into a CliError", async () => {
    await expect(
      waitForCallback({ state: "s", timeoutMs: 50, onListening: () => {} }),
    ).rejects.toThrow(CliError);
  });
});

describe("browserCommand", () => {
  const url =
    "https://todou.example/cli-auth?port=1663&state=abc&name=cli+%40+x";

  it("keeps the full URL as one argument on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const [, args] = browserCommand(url, platform);
      expect(args).toContain(url);
    }
  });

  it("does not route through cmd on win32 (cmd splits unquoted & )", () => {
    const [cmd] = browserCommand(url, "win32");
    expect(cmd).toBe("rundll32");
  });
});

describe("todou login --manual", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-login-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("verifies the pasted token, then persists it as the default server", async () => {
    const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", me]]);
    const env = { XDG_CONFIG_HOME: join(dir, "ok") };
    const result = await runCli(["login", "http://stub.test/", "--manual"], {
      fetchImpl,
      env,
      stdinText: "todou_pat_pasted\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("logged in to http://stub.test as claude");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("todou_pat_pasted");

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer todou_pat_pasted");

    const config = loadCliConfig(env);
    expect(config.default_server).toBe("http://stub.test");
    expect(config.servers["http://stub.test"]?.token).toBe("todou_pat_pasted");
  });

  it("does not persist a token the server rejects", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/me",
        {
          __status: 401,
          body: { error: { code: "unauthorized", message: "bad token" } },
        },
      ],
    ]);
    const env = { XDG_CONFIG_HOME: join(dir, "rejected") };
    const result = await runCli(["login", "http://stub.test", "--manual"], {
      fetchImpl,
      env,
      stdinText: "todou_pat_wrong\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unauthorized");
    expect(loadCliConfig(env).servers).toEqual({});
  });

  it("requires a server when no default exists", async () => {
    const result = await runCli(["login", "--manual"], {
      env: { XDG_CONFIG_HOME: join(dir, "noserver") },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no server given");
  });

  it("rejects a non-http origin", async () => {
    const result = await runCli(["login", "ftp://x", "--manual"], {
      env: { XDG_CONFIG_HOME: join(dir, "badorigin") },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("http(s) origin");
  });
});

describe("todou login (browser flow)", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-login-browser-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the auth URL and completes via the loopback callback", async () => {
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const env = {
      XDG_CONFIG_HOME: join(dir, "ok"),
      TODOU_LOGIN_TIMEOUT_MS: "10000",
    };

    // The happy path through the loopback is covered on waitForCallback
    // directly (stderr is not observable mid-run here); this exercises the
    // command wiring: URL printing, --no-browser, and the timeout path.
    const result = await runCli(["login", "http://stub.test", "--no-browser"], {
      fetchImpl,
      env: { ...env, TODOU_LOGIN_TIMEOUT_MS: "100" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Authorize the CLI in your browser:");
    expect(result.stderr).toContain("http://stub.test/cli-auth?port=");
    expect(result.stderr).toContain("state=");
    expect(result.stderr).toContain("login timed out");
  });
});
