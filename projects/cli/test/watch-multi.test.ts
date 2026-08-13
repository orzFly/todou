import { describe, expect, it } from "vitest";
import { type Captured, fakeFetch, loggedInEnv, runCli } from "./harness.ts";

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
const comment = (id: number, project: string, issue: number, body: string) => ({
  type: "comment",
  id,
  author,
  body,
  created_at: `2026-08-11T12:00:0${id}.000Z`,
  edited_at: null,
  issue_number: issue,
  project,
});

/** Envelope strings are opaque to the CLI; any marker works in tests. */
const ENV1 = "2:fake-envelope-1";
const ENV2 = "2:fake-envelope-2";

const activityParams = (calls: Captured[]) =>
  calls
    .filter((c) => c.url.includes("/api/activity"))
    .map((c) => new URL(c.url, "http://stub.test").searchParams);

describe("watch: multi-project mode over GET /activity", () => {
  it("passes the -p list and --since through, returns tagged items and the envelope", async () => {
    const items = [
      comment(1, "backend", 7, "b"),
      comment(2, "frontend", 3, "f"),
    ];
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === ENV1
            ? { items, next_cursor: ENV2, has_more: false }
            : { items: [], next_cursor: null },
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "frontend,backend", "--poll", "--since", ENV1, "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items.map((i: { project: string }) => i.project)).toEqual([
      "backend",
      "frontend",
    ]);
    expect(parsed.next_cursor).toBe(ENV2);
    const params = activityParams(calls);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) {
      expect(p.get("projects")).toBe("frontend,backend");
    }
    expect(params[0]?.get("after")).toBe(ENV1);
  });

  it("bootstraps at now via last=1 when --since is absent", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("last") === "1"
            ? { items: [], next_cursor: ENV1 }
            : { items: [], next_cursor: null },
      ],
    ]);
    const result = await runCli(["watch", "-p", "aa,bb", "--poll", "--json"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).next_cursor).toBe(ENV1);
    const params = activityParams(calls);
    expect(params[0]?.get("last")).toBe("1");
    expect(params[1]?.get("after")).toBe(ENV1);
  });

  it("--all-projects sends no projects param and conflicts with -p", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/activity", { items: [], next_cursor: null }],
    ]);
    const ok = await runCli(
      ["watch", "--all-projects", "--poll", "--since", ENV1, "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(ok.exitCode).toBe(3);
    for (const p of activityParams(calls)) {
      expect(p.get("projects")).toBeNull();
    }

    const conflict = await runCli(
      ["watch", "--all-projects", "-p", "aa", "--poll"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("--all-projects conflicts");
  });

  it("explains a 404 instead of passing it through raw", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/activity", { __status: 404 }],
    ]);
    const result = await runCli(
      ["watch", "-p", "aa,bb", "--poll", "--since", ENV1],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("predates multi-project watch");
  });

  it("exits 4 when the server stays down, riding the same retry budget", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/activity", { __status: 503 }],
    ]);
    const result = await runCli(
      ["watch", "-p", "aa,bb", "--poll", "--since", ENV1],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain(
      "giving up after 3 consecutive network failures",
    );
  });

  it("spells prefix-less projects as slug/N in text mode", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === ENV1
            ? {
                items: [comment(1, "backend", 7, "hello")],
                next_cursor: ENV2,
                has_more: false,
              }
            : { items: [], next_cursor: null },
      ],
      // No reference-config route: fetchRefPrefix degrades to null and the
      // spelling falls back to slug/N instead of an ambiguous #N.
      ["GET", "/api/projects/backend/references", { __status: 404 }],
      ["GET", "/api/projects/frontend/references", { __status: 404 }],
    ]);
    const result = await runCli(
      ["watch", "-p", "frontend,backend", "--poll", "--since", ENV1],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("backend/7");
    expect(result.stdout).toContain(`cursor: ${ENV2}`);
  });

  it("keeps single-project mode on the per-project endpoint, adding the project field", async () => {
    const item = {
      type: "comment",
      id: 9,
      author,
      body: "solo",
      created_at: "2026-08-11T12:00:00Z",
      edited_at: null,
      issue_number: 3,
    };
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? { items: [item], next_cursor: "a1" }
            : { items: [], next_cursor: null },
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items[0]?.project).toBe("todou");
    expect(parsed.next_cursor).toBe("a1");
    expect(calls.some((c) => c.url.includes("/api/activity?"))).toBe(false);
  });
});
