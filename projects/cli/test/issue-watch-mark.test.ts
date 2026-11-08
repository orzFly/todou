import { AGENT_CONTEXT_HEADER } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  type Captured,
  fakeFetch,
  loggedInEnv,
  type Route,
  runCli,
} from "./harness.ts";

const CONFIG: Route = [
  "GET",
  "/api/projects/todou/references/config",
  { format: { prefix: "T", history: [] }, autolinks: [] },
];

const mark = (number: number): Route => [
  "PUT",
  `/api/projects/todou/issues/${number}/watch`,
  {
    issue_number: number,
    since: "2026-11-08T13:50:00.000Z",
    expires_at: "2026-11-08T14:05:00.000Z",
  },
];

const unmark = (number: number): Route => [
  "DELETE",
  `/api/projects/todou/issues/${number}/watch`,
  { __status: 204 },
];

/** Runs as if under Claude Code, so a context is detected without the flag. */
const agentEnv = { ...loggedInEnv("todou"), CLAUDECODE: "1" };

const header = (call: Captured) =>
  new Headers(call.init.headers).get(AGENT_CONTEXT_HEADER);
const writes = (calls: Captured[]) =>
  calls.filter((c) => c.init.method === "PUT" || c.init.method === "DELETE");

describe("issue watch-add / watch-renew / watch-remove (T-669)", () => {
  for (const verb of ["watch-add", "watch-renew"]) {
    it(`${verb} sends one PUT per card with the TTL and prints each expiry`, async () => {
      const { fetchImpl, calls } = fakeFetch([CONFIG, mark(16), mark(17)]);
      const result = await runCli(["issue", verb, "16", "17", "--ttl", "600"], {
        fetchImpl,
        env: agentEnv,
      });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const puts = writes(calls);
      expect(puts.map((c) => new URL(c.url).pathname)).toEqual([
        "/api/projects/todou/issues/16/watch",
        "/api/projects/todou/issues/17/watch",
      ]);
      for (const put of puts) {
        expect(JSON.parse(String(put.init.body))).toEqual({ ttl_seconds: 600 });
      }
      expect(result.stdout).toBe(
        "T-16 watched until 2026-11-08T14:05:00.000Z\n" +
          "T-17 watched until 2026-11-08T14:05:00.000Z\n",
      );
    });
  }

  it("leaves the TTL to the server when --ttl is absent", async () => {
    const { fetchImpl, calls } = fakeFetch([CONFIG, mark(16)]);
    const result = await runCli(["issue", "watch-add", "16"], {
      fetchImpl,
      env: agentEnv,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(writes(calls)[0]?.init.body))).toEqual({});
  });

  it("sends exactly the --agent-context it was given", async () => {
    const given = { agent: "claude-code", session_id: "s-demo" };
    const { fetchImpl, calls } = fakeFetch([CONFIG, mark(16), unmark(16)]);
    for (const verb of ["watch-add", "watch-remove"]) {
      const result = await runCli(
        ["issue", verb, "16", "--agent-context", JSON.stringify(given)],
        // No harness here: the flag alone has to be enough.
        { fetchImpl, env: loggedInEnv("todou") },
      );
      expect(result.exitCode).toBe(0);
    }
    for (const call of writes(calls)) {
      expect(JSON.parse(header(call) ?? "null")).toEqual(given);
    }
    expect(writes(calls)).toHaveLength(2);
  });

  it("fails before any request on a malformed --agent-context or none at all", async () => {
    for (const [argv, said] of [
      [["--agent-context", "{nope"], "not valid JSON"],
      [["--agent-context", '{"session_id":"s1"}'], "agent context shape"],
      [[], "no agent context to watch as"],
    ] as const) {
      const { fetchImpl, calls } = fakeFetch([CONFIG, mark(16)]);
      const result = await runCli(["issue", "watch-add", "16", ...argv], {
        fetchImpl,
        env: loggedInEnv("todou"),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(said);
      expect(calls).toEqual([]);
    }
  });

  it("watch-remove sends DELETE and says so", async () => {
    const { fetchImpl, calls } = fakeFetch([CONFIG, unmark(16)]);
    const result = await runCli(["issue", "watch-remove", "16"], {
      fetchImpl,
      env: agentEnv,
    });
    expect(result.exitCode).toBe(0);
    expect(writes(calls).map((c) => c.init.method)).toEqual(["DELETE"]);
    expect(result.stdout).toBe("T-16 watch removed\n");
  });

  it("prints parseable JSON: the marks, or [] for a removal", async () => {
    const { fetchImpl } = fakeFetch([CONFIG, mark(16), unmark(16)]);
    const added = await runCli(["issue", "watch-add", "16", "--json"], {
      fetchImpl,
      env: agentEnv,
    });
    expect(JSON.parse(added.stdout)).toEqual([
      {
        issue_number: 16,
        since: "2026-11-08T13:50:00.000Z",
        expires_at: "2026-11-08T14:05:00.000Z",
      },
    ]);
    const removed = await runCli(["issue", "watch-remove", "16", "--json"], {
      fetchImpl,
      env: agentEnv,
    });
    expect(JSON.parse(removed.stdout)).toEqual([]);
  });
});
