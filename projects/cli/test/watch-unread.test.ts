import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};
const other = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human",
  owner: null,
};
const status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#6b7280",
  position: 0,
  is_default: false,
};
const listItem = (number: number, title: string) => ({
  id: number * 10,
  number,
  title,
  status,
  author: other,
  assignees: [],
  labels: [],
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
  body_edited_at: null,
});
const issuePage = {
  items: [listItem(3, "Fix the potato"), listItem(4, "Water the field")],
  next_cursor: null,
};
const webComment = {
  type: "comment",
  id: 9,
  author: other,
  body: "web comment",
  created_at: "2026-08-11T12:00:00Z",
  edited_at: null,
  issue_number: 3,
};
const page = (items: unknown[], next: string | null) => ({
  items,
  next_cursor: next,
});

describe("unread markers (local state)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "todou-state-"));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
  const env = { ...loggedInEnv("todou"), XDG_STATE_HOME: stateDir };

  it("first run bootstraps the frontier without marking history", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues", issuePage],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) => {
          expect(url.searchParams.get("last")).toBe("1");
          return page([], "f0");
        },
      ],
    ]);
    const result = await runCli(["issue", "list"], { fetchImpl, env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("●");
  });

  it("marks issues with foreign activity, and --unread filters to them", async () => {
    const activity = (_init: RequestInit, url: URL) => {
      expect(url.searchParams.get("exclude_actor")).toBe("2");
      return url.searchParams.get("after") === "f0"
        ? page([webComment], "f1")
        : page([], null);
    };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues", issuePage],
      ["GET", "/api/me", me],
      ["GET", "/api/projects/todou/activity", activity],
    ]);
    const marked = await runCli(["issue", "list"], { fetchImpl, env });
    const line3 = marked.stdout.split("\n").find((l) => l.includes("#3"));
    const line4 = marked.stdout.split("\n").find((l) => l.includes("#4"));
    expect(line3).toContain("●");
    expect(line4).not.toContain("●");

    const filtered = await runCli(["issue", "list", "--unread", "--json"], {
      fetchImpl,
      env,
    });
    const parsed = JSON.parse(filtered.stdout) as {
      items: Array<{ number: number }>;
    };
    expect(parsed.items.map((i) => i.number)).toEqual([3]);
  });

  it("issue view marks the issue read", async () => {
    const issue = { ...listItem(3, "Fix the potato"), body: "" };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "t1"
            ? page([], null)
            : { items: [webComment], prev_cursor: null, next_cursor: "t1" },
      ],
    ]);
    const viewed = await runCli(["issue", "view", "3"], { fetchImpl, env });
    expect(viewed.exitCode).toBe(0);

    // Re-scanning the same foreign entry must not resurrect the marker:
    // its created_at is not newer than what the view recorded.
    const { fetchImpl: listFetch } = fakeFetch([
      ["GET", "/api/projects/todou/issues", issuePage],
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "f1"
            ? page([webComment], "f2")
            : page([], null),
      ],
    ]);
    const after = await runCli(["issue", "list"], {
      fetchImpl: listFetch,
      env,
    });
    expect(after.stdout).not.toContain("●");

    const unread = await runCli(["issue", "list", "--unread"], {
      fetchImpl: fakeFetch([
        ["GET", "/api/projects/todou/issues", issuePage],
        ["GET", "/api/me", me],
        ["GET", "/api/projects/todou/activity", page([], null)],
      ]).fetchImpl,
      env,
    });
    expect(unread.stdout).toBe("no unread issues\n");
  });

  it("degrades silently when the server has no /activity", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues", issuePage],
    ]);
    const result = await runCli(["issue", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#3");
  });
});

describe("watch (project-level)", () => {
  it("excludes the current user by default and tags issue numbers", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? page([webComment], "a1")
            : page([], null),
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{ issue_number: number; body: string }>;
      next_cursor: string;
    };
    expect(parsed.items[0]?.issue_number).toBe(3);
    expect(parsed.next_cursor).toBe("a1");
    const activityCall = calls.find((c) => c.url.includes("/activity"));
    expect(activityCall?.url).toContain("exclude_actor=2");
  });

  it("renders issue numbers for humans", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? page([webComment], "a1")
            : page([], null),
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.stdout).toContain("#3 user commented");
    expect(result.stdout).toContain("web comment");
    expect(result.stdout).toContain("cursor: a1");
  });

  it("--debounce batches a cross-issue burst into one wake-up", async () => {
    // Live entries: created_at ≈ first sight, so the full window applies.
    const liveComment = {
      ...webComment,
      created_at: new Date().toISOString(),
    };
    let a1Calls = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "a0") return page([liveComment], "a1");
          if (after === "a1") {
            a1Calls += 1;
            return a1Calls === 1
              ? page([], null)
              : page(
                  [
                    {
                      ...liveComment,
                      id: 10,
                      body: "second card",
                      issue_number: 4,
                    },
                  ],
                  "a2",
                );
          }
          return page([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "watch",
        "-p",
        "todou",
        "--since",
        "a0",
        "--debounce",
        "0.4",
        "--interval",
        "0.05",
        "--timeout",
        "5",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{ issue_number: number }>;
      next_cursor: string;
    };
    expect(parsed.items.map((i) => i.issue_number)).toEqual([3, 4]);
    expect(parsed.next_cursor).toBe("a2");
  });

  it("--any-actor skips /me and the actor filter; bootstrap uses last=1", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("last") === "1"
            ? page([], "a0")
            : page([], null),
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--any-actor", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(3);
    const parsed = JSON.parse(result.stdout) as { next_cursor: string };
    expect(parsed.next_cursor).toBe("a0");
    expect(calls.some((c) => c.url.includes("/api/me"))).toBe(false);
    expect(calls.some((c) => c.url.includes("exclude_actor"))).toBe(false);
  });
});
