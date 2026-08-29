import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCliConfig } from "../src/config.ts";
import { CliError } from "../src/errors.ts";
import { browserCommand, waitForCallback } from "../src/login-flow.ts";
import { fakeFetch, type Route, runCli, virtualClock } from "./harness.ts";

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

describe("todou login --no-browser (device flow)", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-login-device-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const created = {
    id: 7,
    code: "AB3DEFGH",
    poll_secret: "poll-s3cret",
    interval: 3,
    expires_in: 900,
  };
  const notFound = {
    __status: 404,
    body: {
      error: { code: "not_found", message: "cli auth request not found" },
    },
  };

  /** Every device-flow run needs the create call; poll differs per case. */
  const routes = (poll: Route[2]): Route[] => [
    ["POST", "/api/auth/cli/requests", created],
    ["POST", "/api/auth/cli/requests/7/poll", poll],
    ["GET", "/api/me", me],
  ];

  const run = (name: string, fetchImpl: typeof fetch, timeoutMs = "60000") =>
    runCli(["login", "http://stub.test", "--no-browser"], {
      fetchImpl,
      env: {
        XDG_CONFIG_HOME: join(dir, name),
        TODOU_LOGIN_TIMEOUT_MS: timeoutMs,
      },
      clock: virtualClock(),
    });

  it("prints the code, polls until approved, and stores the token", async () => {
    let polls = 0;
    const { fetchImpl, calls } = fakeFetch(
      routes(() => {
        polls += 1;
        return polls < 3
          ? { status: "pending" }
          : { status: "approved", token: "todou_pat_device" };
      }),
    );
    const env = {
      XDG_CONFIG_HOME: join(dir, "ok"),
      TODOU_LOGIN_TIMEOUT_MS: "60000",
    };
    const result = await runCli(["login", "http://stub.test", "--no-browser"], {
      fetchImpl,
      env,
      clock: virtualClock(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "First, copy your one-time code: AB3D-EFGH",
    );
    expect(result.stderr).toContain("http://stub.test/cli-auth?code=AB3D-EFGH");
    // The whole point of the flow: no loopback port is involved anywhere.
    expect(result.stderr).not.toContain("port=");
    expect(result.stderr).not.toContain("todou_pat_device");
    expect(result.stderr).toContain("logged in to http://stub.test as claude");
    expect(polls).toBe(3);

    const name = JSON.parse(String(calls[0]?.init.body)).name;
    expect(name.startsWith("cli @ ")).toBe(true);
    expect(loadCliConfig(env).servers["http://stub.test"]?.token).toBe(
      "todou_pat_device",
    );
  });

  it("keeps polling through a transient network failure", async () => {
    let polls = 0;
    const { fetchImpl } = fakeFetch(
      routes(() => {
        polls += 1;
        if (polls === 1) throw new TypeError("fetch failed");
        return { status: "approved", token: "todou_pat_after_blip" };
      }),
    );
    const result = await run("blip", fetchImpl);
    expect(result.exitCode).toBe(0);
    expect(polls).toBe(2);
  });

  it("fails fast when the request is denied", async () => {
    const { fetchImpl } = fakeFetch(routes({ status: "denied" }));
    const result = await run("denied", fetchImpl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("login request was denied");
    expect(result.stderr).toContain("--no-browser");
  });

  it("reports an expired request instead of waiting it out", async () => {
    const { fetchImpl } = fakeFetch(routes(notFound));
    const result = await run("expired", fetchImpl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("login request expired or was not found");
  });

  it("times out on its own deadline while the request stays pending", async () => {
    let polls = 0;
    const { fetchImpl } = fakeFetch(
      routes(() => {
        polls += 1;
        return { status: "pending" };
      }),
    );
    const result = await run("timeout", fetchImpl, "5000");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("login timed out");
    expect(result.stderr).toContain("--manual");
    // 5s of budget at a 3s interval: poll at 0s and at 3s, then give up.
    expect(polls).toBe(2);
  });

  it("names the escape hatch when the server is too old for the flow", async () => {
    const { fetchImpl } = fakeFetch([
      ["POST", "/api/auth/cli/requests", notFound],
    ]);
    const result = await run("oldserver", fetchImpl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "this server does not support --no-browser login",
    );
    expect(result.stderr).toContain("--manual");
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
    // command wiring: URL printing, opening the browser, and the timeout.
    const opened: string[] = [];
    const result = await runCli(["login", "http://stub.test"], {
      fetchImpl,
      env: { ...env, TODOU_LOGIN_TIMEOUT_MS: "100" },
      openBrowser: (url) => opened.push(url),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Authorize the CLI in your browser:");
    expect(result.stderr).toContain("http://stub.test/cli-auth?port=");
    expect(result.stderr).toContain("state=");
    expect(result.stderr).toContain("login timed out");
    expect(opened[0]).toContain("http://stub.test/cli-auth?port=");
  });
});
