import { describe, expect, it } from "vitest";
import {
  type Captured,
  fakeFetch,
  loggedInEnv,
  parseNdjson,
  runCli,
  virtualClock,
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
  it("passes the -p list and --since through, returns tagged items and the cursor record", async () => {
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
    const {
      items: got,
      cursor,
      lines,
    } = parseNdjson<{ project: string }>(result.stdout);
    expect(got.map((i) => i.project)).toEqual(["backend", "frontend"]);
    expect(cursor).toEqual({ type: "cursor", next_cursor: ENV2 });
    // One line per entry plus the cursor record — nothing wraps, nothing
    // spans, so `tail -n1` and `jq` per line both hold.
    expect(lines).toBe(items.length + 1);
    // A cross-project stream has no one ref format to state.
    expect(cursor.ref_format).toBeUndefined();
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
    expect(result.exitCode).toBe(0);
    // An empty poll is one cursor record and nothing else — which is what
    // keeps `--poll --json | jq -r .next_cursor` bootstrapping cursors.
    const { items, cursor, lines } = parseNdjson(result.stdout);
    expect(items).toEqual([]);
    expect(lines).toBe(1);
    expect(cursor.next_cursor).toBe(ENV1);
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
    expect(ok.exitCode).toBe(0);
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
      { fetchImpl, env: loggedInEnv(), clock: virtualClock() },
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

  it("renders block relations per project without resolving other cards or rewriting NDJSON", async () => {
    const block = (
      id: number,
      project: string,
      issue_number: number,
      event_type: string,
      payload: Record<string, unknown>,
    ) => ({
      type: "event",
      id,
      actor: author,
      event_type,
      payload,
      created_at: "2026-08-11T12:00:00Z",
      issue_number,
      project,
    });
    const items = [
      block(81, "backend", 7, "block_added", {
        edge_id: 401,
        role: "blocked",
        other_project_id: 7,
        other_project: "current-acme",
        other_number: 9,
      }),
      block(82, "frontend", 3, "block_removed", {
        edge_id: 402,
        role: "blocker",
        other_project_id: 7,
        other_project: null,
        other_number: 10,
      }),
      block(83, "frontend", 3, "block_cleared", {
        edge_id: 403,
        blocker_project_id: null,
        blocker_project: null,
        blocker_number: null,
      }),
      block(84, "backend", 7, "block_reblocked", {
        edge_id: 404,
        blocker_project_id: 7,
        blocker_number: 11,
      }),
    ];
    const run = async (json: boolean) => {
      const { fetchImpl, calls } = fakeFetch([
        ["GET", "/api/me", me],
        [
          "GET",
          "/api/projects",
          [
            { id: 2, slug: "backend" },
            { id: 3, slug: "frontend" },
            { id: 7, slug: "stale-acme" },
          ],
        ],
        [
          "GET",
          "/api/projects/backend/references/config",
          {
            format: { prefix: "B", history: [] },
            autolinks: [],
          },
        ],
        [
          "GET",
          "/api/projects/frontend/references/config",
          {
            format: { prefix: "F", history: [] },
            autolinks: [],
          },
        ],
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
        [
          "watch",
          "-p",
          "frontend,backend",
          "--poll",
          "--since",
          ENV1,
          ...(json ? ["--json"] : []),
        ],
        { fetchImpl, env: loggedInEnv() },
      );
      expect(result.exitCode).toBe(0);
      expect(
        calls.filter((c) => new URL(c.url).pathname === "/api/projects"),
      ).toHaveLength(1);
      expect(
        calls.some(
          (c) => c.url.includes("/issues") || c.url.includes("/blocks"),
        ),
      ).toBe(false);
      return result.stdout;
    };

    const human = await run(false);
    expect(human).toContain("B-7 User block_added (blocked by current-acme/9)");
    expect(human).toContain("F-3 User block_removed (removed block on 7/10)");
    expect(human).toContain(
      "F-3 User block_cleared (block by a card you cannot see cleared)",
    );
    expect(human).toContain(
      "B-7 User block_reblocked (block by 7/11 active again)",
    );
    expect(human).not.toContain("stale-acme/9");
    expect(human).toContain(`cursor: ${ENV2}`);

    const json = await run(true);
    const {
      items: got,
      cursor,
      lines,
    } = parseNdjson<{
      payload: Record<string, unknown>;
    }>(json);
    expect(got).toEqual(
      items.map((entry) => ({
        ...entry,
        issue_ref: entry.project === "backend" ? "B-7" : "F-3",
      })),
    );
    expect(got[3]?.payload).not.toHaveProperty("blocker_project");
    expect(cursor).toEqual({ type: "cursor", next_cursor: ENV2 });
    expect(lines).toBe(items.length + 1);
    expect(json).not.toContain("a card you cannot see");
    expect(json).not.toContain("removed block on");
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
    const { items, cursor } = parseNdjson<{ project: string }>(result.stdout);
    // The item line is the v0.2.0 `items[]` element, unchanged but for the
    // ref spelling the envelope used to carry.
    expect(items[0]).toEqual({ ...item, issue_ref: "#3", project: "todou" });
    expect(cursor.next_cursor).toBe("a1");
    expect(calls.some((c) => c.url.includes("/api/activity?"))).toBe(false);
  });
});

describe("watch --poll --print-cursor", () => {
  const soloRoutes = (items: unknown[], cursor: string | null) =>
    [
      ["GET", "/api/me", me],
      ["GET", "/api/projects/todou/references/config", { format: {} }],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? { items, next_cursor: cursor }
            : { items: [], next_cursor: "a0" },
      ],
    ] as Parameters<typeof fakeFetch>[0];

  it("prints the cursor alone and exits 0 on an empty poll", async () => {
    const { fetchImpl } = fakeFetch(soloRoutes([], null));
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--print-cursor"],
      { fetchImpl, env: loggedInEnv() },
    );
    // The default poll answers 3 here; the cursor was still produced, and
    // it is the whole product of this flag.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a0\n");
  });

  it("prints the cursor alone when there were entries too", async () => {
    const item = {
      type: "comment",
      id: 9,
      author,
      body: "solo",
      created_at: "2026-08-11T12:00:00Z",
      edited_at: null,
      issue_number: 3,
    };
    const { fetchImpl } = fakeFetch(soloRoutes([item], "a1"));
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--print-cursor"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a1\n");
  });

  it("works across a multi-project poll", async () => {
    const { fetchImpl } = fakeFetch([
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
    const result = await runCli(
      ["watch", "-p", "aa,bb", "--poll", "--print-cursor"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${ENV1}\n`);
  });

  it("refuses --json and a blocking watch", async () => {
    const { fetchImpl } = fakeFetch(soloRoutes([], null));
    const withJson = await runCli(
      ["watch", "-p", "todou", "--poll", "--print-cursor", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(withJson.exitCode).toBe(1);
    expect(withJson.stderr).toContain("both want stdout");

    const blocking = await runCli(["watch", "-p", "todou", "--print-cursor"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(blocking.exitCode).toBe(1);
    expect(blocking.stderr).toContain("only makes sense with --poll");
  });

  it("says so rather than printing an empty cursor", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/projects/todou/activity", { items: [], next_cursor: null }],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--print-cursor"],
      { fetchImpl, env: loggedInEnv() },
    );
    // An empty capture would silently mean "start at now" at the next call,
    // which is the confusion this flag exists to end.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no cursor to print");
  });
});
