import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

describe("api passthrough", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-api-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("issues a GET with query fields and prints JSON", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me/tokens", [{ id: 1, name: "cli" }]],
    ]);
    const result = await runCli(
      ["api", "get", "/me/tokens", "-f", "active=1"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.url).toBe("http://stub.test/api/me/tokens?active=1");
    expect(JSON.parse(result.stdout)).toEqual([{ id: 1, name: "cli" }]);
  });

  it("POSTs an inline JSON body", async () => {
    let posted: unknown;
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects",
        (init: RequestInit) => {
          posted = JSON.parse(String(init.body));
          return { id: 5, slug: "x" };
        },
      ],
    ]);
    const result = await runCli(
      ["api", "post", "/projects", "--body", '{"slug":"x","name":"X"}'],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({ slug: "x", name: "X" });
  });

  it("reads @file and - bodies", async () => {
    const file = join(dir, "payload.json");
    writeFileSync(file, '{"from":"file"}');
    const bodies: unknown[] = [];
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/echo",
        (init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)));
          return { ok: true };
        },
      ],
    ]);
    await runCli(["api", "post", "/echo", "--body", `@${file}`], {
      fetchImpl,
      env: loggedInEnv(),
    });
    await runCli(["api", "post", "/echo", "--body", "-"], {
      fetchImpl,
      env: loggedInEnv(),
      stdinText: '{"from":"stdin"}',
    });
    expect(bodies).toEqual([{ from: "file" }, { from: "stdin" }]);
  });

  it("prints nothing for 204 responses", async () => {
    const { fetchImpl } = fakeFetch([
      ["DELETE", "/api/me/tokens/3", { __status: 204 }],
    ]);
    const result = await runCli(["api", "delete", "/me/tokens/3"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects bad methods, paths, fields, and JSON", async () => {
    const { fetchImpl } = fakeFetch([]);
    const env = loggedInEnv();
    const bad = [
      ["api", "brew", "/tea"],
      ["api", "get", "me"],
      ["api", "get", "/me", "-f", "oops"],
      ["api", "post", "/me", "--body", "{nope"],
    ];
    for (const argv of bad) {
      const result = await runCli(argv, { fetchImpl, env });
      expect(result.exitCode).toBe(1);
    }
  });

  it("surfaces API errors with their code", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/nope",
        {
          __status: 404,
          body: { error: { code: "not_found", message: "no such project" } },
        },
      ],
    ]);
    const result = await runCli(["api", "get", "/projects/nope"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error: not_found — no such project\n");
  });
});
