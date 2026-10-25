import { describe, expect, it } from "vitest";
import {
  type Captured,
  fakeFetch,
  loggedInEnv,
  parseNdjson,
  type Route,
  runCli,
} from "./harness.ts";

const me = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  owner: null,
};
const author = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human",
  owner: null,
};
const item = {
  type: "comment",
  id: 1,
  author,
  body: "ping",
  created_at: "2026-10-25T12:00:01.000Z",
  edited_at: null,
  issue_number: 7,
};

const scopes = (calls: Captured[], path: string) =>
  calls
    .map((c) => new URL(c.url, "http://stub.test"))
    .filter((u) => u.pathname === path && u.searchParams.has("after"))
    .map((u) => u.searchParams.get("scope"));

/** Two pages from `after=a0`, so a warning has a second chance to repeat. */
const activity = (path: string, echo: boolean, extra = {}): Route => [
  "GET",
  path,
  (_init: RequestInit, url: URL) => {
    const scope = url.searchParams.get("scope");
    const echoed =
      echo && scope !== null ? { scope: scope.split(",").sort() } : {};
    return url.searchParams.get("after") === "a0"
      ? {
          items: [{ ...item, ...extra }],
          next_cursor: "a1",
          has_more: true,
          ...echoed,
        }
      : { items: [], next_cursor: null, ...echoed };
  },
];

const WARNING = "predates --mine";

describe("watch --mine (T-576)", () => {
  it("asks the server for this account's scope and stays quiet when it is applied", async () => {
    const path = "/api/projects/todou/activity";
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      activity(path, true),
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--mine", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(parseNdjson(result.stdout).items).toHaveLength(1);
    expect(scopes(calls, path)).toEqual([
      "assigned,mentioned",
      "assigned,mentioned",
    ]);
    expect(result.stderr).not.toContain(WARNING);
  });

  it("sends no scope without --mine", async () => {
    const path = "/api/projects/todou/activity";
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      activity(path, true),
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(scopes(calls, path)).toEqual([null, null]);
    expect(result.stderr).not.toContain(WARNING);
  });

  it("carries the scope across projects", async () => {
    const path = "/api/activity";
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      activity(path, true, { project: "todou" }),
    ]);
    const result = await runCli(
      ["watch", "--all-projects", "--mine", "--poll", "--since", "a0"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(scopes(calls, path)).toEqual([
      "assigned,mentioned",
      "assigned,mentioned",
    ]);
    expect(result.stderr).not.toContain(WARNING);
  });

  it("says once that an old server delivered everything, and delivers it", async () => {
    const path = "/api/projects/todou/activity";
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      activity(path, false),
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--mine", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson(result.stdout);
    expect(items).toHaveLength(1);
    expect(cursor.next_cursor).toBe("a1");
    expect(result.stderr.split(WARNING)).toHaveLength(2);
  });
});
