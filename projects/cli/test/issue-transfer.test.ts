import { describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};
const status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#6b7280",
  position: 0,
};
const issue = {
  id: 11,
  number: 3,
  title: "Fix the potato",
  body: "",
  status,
  author: me,
  assignees: [],
  labels: [],
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
  deleted_at: null,
  deleted_by: null,
  moves: [],
};

const result = (over: Record<string, unknown> = {}) => ({
  moved_to: { slug: "other", number: 45 },
  reinhabited: false,
  mapping: {
    status: { from: "Todo", to: "Backlog" },
    dropped_labels: ["area:web"],
    dropped_assignees: [{ id: 9, login: "bot-one", display_name: "Bot One" }],
  },
  issue: { ...issue, number: 45 },
  ...over,
});

const noRefFormats = [
  ["GET", "/api/projects/todou/references/config", { __status: 404 }],
  ["GET", "/api/projects/other/references/config", { __status: 404 }],
] as Parameters<typeof fakeFetch>[0];

describe("issue transfer", () => {
  it("refuses to move without a confirmation off a terminal", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ...noRefFormats,
    ]);
    const run = await runCli(
      ["issue", "transfer", "3", "--to", "other", "-p", "todou"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("refusing to move without a confirmation");
    expect(calls.some((c) => c.url.includes("/move"))).toBe(false);
  });

  it("prints the mapping and writes nothing under --dry-run", async () => {
    let body: unknown;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ...noRefFormats,
      [
        "POST",
        "/api/projects/todou/issues/3/move",
        (init: RequestInit) => {
          body = JSON.parse(String(init.body));
          return result({
            moved_to: { slug: "other", number: null },
            issue: null,
          });
        },
      ],
    ]);
    const run = await runCli(
      ["issue", "transfer", "3", "--to", "other", "-p", "todou", "--dry-run"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(run.exitCode).toBe(0);
    expect(body).toEqual({ to_project: "other", dry_run: true });
    expect(run.stdout).toContain("would take a new number");
    expect(run.stdout).toContain("status: Todo → Backlog");
    expect(run.stdout).toContain("dropped labels: area:web");
    expect(run.stdout).toContain("dropped assignees: @bot-one");
  });

  it("moves under -y and reports the new ref", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ...noRefFormats,
      ["POST", "/api/projects/todou/issues/3/move", result()],
    ]);
    const run = await runCli(
      ["issue", "transfer", "3", "--to", "other", "-p", "todou", "-y"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("#3 → other/45");
    // Under -y the preview is skipped: one move request, no dry run.
    const moves = calls.filter((c) => c.url.includes("/move"));
    expect(moves).toHaveLength(1);
    expect(JSON.parse(String(moves[0]?.init.body)).dry_run).toBe(false);
  });

  it("says when the card reclaimed its old number", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ...noRefFormats,
      [
        "POST",
        "/api/projects/todou/issues/3/move",
        result({ reinhabited: true }),
      ],
    ]);
    const run = await runCli(
      ["issue", "transfer", "3", "--to", "other", "-p", "todou", "-y"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(run.stdout).toContain("reinhabited its previous number");
  });
});

describe("reading a card that moved", () => {
  const movedBody = { moved_to: { slug: "other", number: 45 } };

  const refConfig = (prefix: string) => ({
    format: { prefix, history: [] },
    autolinks: [],
  });
  /**
   * A distinct prefix per project. With both projects answering the same
   * thing — or both answering 404, as this suite used to — a number spelled
   * in the wrong project's format is indistinguishable from a right one, and
   * that is exactly the bug (T-246).
   */
  const twoPrefixes = [
    ["GET", "/api/projects/todou/references/config", refConfig("CH")],
    ["GET", "/api/projects/other/references/config", refConfig("RN")],
  ] as Route[];

  const emptyPage = {
    items: [],
    prev_cursor: null,
    next_cursor: null,
    total_count: 0,
  };
  const followedRoutes = [
    ["GET", "/api/projects/todou/issues/3", { __status: 301, body: movedBody }],
    ["GET", "/api/projects/other/issues/45", { ...issue, number: 45 }],
    ["GET", "/api/projects/other/issues/45/timeline", emptyPage],
    ["PUT", "/api/projects/other/issues/45/read", { __status: 204 }],
  ] as Route[];

  /**
   * `markRead` swallows every failure, so a route table that spells the
   * right read address proves nothing on its own: the request can miss it
   * entirely and the command still succeeds. Only the calls do.
   */
  const readPaths = (calls: { url: string }[]) =>
    calls
      .filter((c) => c.url.endsWith("/read"))
      .map((c) => new URL(c.url).pathname);

  it("follows the redirect and says where it came from", async () => {
    const { fetchImpl } = fakeFetch([...followedRoutes, ...twoPrefixes]);
    const run = await runCli(["issue", "view", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("moved from todou/3");
    expect(run.stdout).toContain("other/RN-45 Fix the potato");
    // `CH-45` is what the source project's prefix would spell, and in the
    // deployment this was found on it named a different card that existed.
    expect(run.stdout).not.toContain("CH-45");
  });

  // Its own test on purpose: this failure is silent, so an assertion sharing
  // a test with the visible one never gets to run.
  it("marks the card read in the project it landed in", async () => {
    const { fetchImpl, calls } = fakeFetch([...followedRoutes, ...twoPrefixes]);
    const run = await runCli(["issue", "view", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(run.exitCode).toBe(0);
    expect(readPaths(calls)).toEqual(["/api/projects/other/issues/45/read"]);
  });

  it("carries the move and the landing project's format into --json", async () => {
    const { fetchImpl } = fakeFetch([...followedRoutes, ...twoPrefixes]);
    const run = await runCli(["issue", "view", "3", "-p", "todou", "--json"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      issue: { number: number; ref: string };
      moved_from: unknown;
      ref_format: unknown;
    };
    expect(parsed.moved_from).toEqual({ slug: "todou", number: 3 });
    expect(parsed.issue.ref).toBe("other/RN-45");
    expect(parsed.issue.number).toBe(45);
    expect(parsed.ref_format).toEqual({ prefix: "RN", token: "RN-" });
  });

  it("leaves a card that did not move spelled as a bare number", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", emptyPage],
      ["PUT", "/api/projects/todou/issues/3/read", { __status: 204 }],
      ...twoPrefixes,
    ]);
    const run = await runCli(["issue", "view", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("CH-3 Fix the potato");
    expect(run.stdout).not.toContain("todou/CH-3");
    expect(run.stdout).not.toContain("moved from");
  });

  it("degrades to the bare form when the landing project has no prefix", async () => {
    const { fetchImpl } = fakeFetch([
      ...followedRoutes,
      ["GET", "/api/projects/todou/references/config", refConfig("CH")],
      ["GET", "/api/projects/other/references/config", { __status: 404 }],
    ]);
    const run = await runCli(["issue", "view", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("other/#45 Fix the potato");
  });

  it("reports a 410 without naming the destination", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3",
        { __status: 410, body: { moved: true, title: "Fix the potato" } },
      ],
      ...noRefFormats,
    ]);
    const run = await runCli(["issue", "view", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("moved to a project you cannot read");
    expect(run.stderr).toContain("Fix the potato");
  });

  it("hands a watch the new ref and a cursor to re-anchor from", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        { __status: 301, body: movedBody },
      ],
      [
        "GET",
        "/api/projects/other/issues/45/timeline",
        { items: [], prev_cursor: null, next_cursor: "cur-45", total_count: 0 },
      ],
      ["GET", "/api/me", me],
      ...noRefFormats,
    ]);
    const run = await runCli(["issue", "watch", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("moved to other/45");
    // The cursor is a row position in the source database, so the watcher
    // is handed a new one rather than left resuming from a stale one.
    expect(run.stdout).toContain("--since cur-45");
  });
});
