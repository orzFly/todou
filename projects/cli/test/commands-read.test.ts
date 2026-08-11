import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCliConfig, saveCliConfig } from "../src/config.ts";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};
const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
  { id: 2, name: "Done", category: "closed", color: "#22c55e", position: 1 },
];
const labels = [{ id: 7, name: "bug", color: "#ef4444" }];
const issue = {
  id: 11,
  number: 3,
  title: "Fix the potato",
  body: "It sprouted.",
  status: statuses[0],
  author: me,
  assignees: [me],
  labels,
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
};

describe("whoami", () => {
  it("prints identity, and raw JSON under --json", async () => {
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const human = await runCli(["whoami"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("claude (Claude) · machine @ http://stub.test\n");

    const json = await runCli(["whoami", "--json"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(JSON.parse(json.stdout)).toEqual(me);
  });

  it("fails with guidance when no server is configured", async () => {
    const result = await runCli(["whoami"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no server configured");
    expect(result.stderr).toContain("todou login");
  });

  it("fails with guidance when the server has no token", async () => {
    const result = await runCli(["whoami"], {
      env: { TODOU_SERVER: "http://stub.test" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not logged in to http://stub.test");
  });
});

describe("project list", () => {
  it("renders a slug/name table", async () => {
    const projects = [
      { id: 1, slug: "dogfood", name: "Dogfood", description: "sandbox" },
    ];
    const { fetchImpl } = fakeFetch([["GET", "/api/projects", projects]]);
    const result = await runCli(["project", "list"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.stdout).toBe("dogfood  Dogfood  sandbox\n");
  });
});

describe("issue list", () => {
  it("resolves filter names to ids in the query", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      ["GET", "/api/projects/todou/labels", labels],
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue], next_cursor: null },
      ],
    ]);
    const result = await runCli(
      ["issue", "list", "--status", "todo", "--label", "bug", "--limit", "5"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    const listCall = calls.find((c) => c.url.includes("/issues?"));
    const url = new URL(listCall?.url ?? "", "http://stub.test");
    expect(url.searchParams.get("status")).toBe("1");
    expect(url.searchParams.get("label")).toBe("7");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(result.stdout).toContain("#3");
    expect(result.stdout).toContain("Fix the potato");
  });

  it("maps --open/--closed to the category param and rejects combos", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
    ]);
    const result = await runCli(["issue", "list", "--closed"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toBe("no issues\n");
    expect(calls[0]?.url).toContain("category=closed");

    const combo = await runCli(["issue", "list", "--open", "--closed"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(combo.exitCode).toBe(1);
    expect(combo.stderr).toContain("mutually exclusive");
  });

  it("requires a project", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "list"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no project selected");
    expect(result.stderr).toContain("todou project link");
  });
});

describe("issue view", () => {
  const timelinePages = [
    {
      items: [
        {
          type: "comment",
          id: 1,
          author: me,
          body: "first",
          created_at: "2026-08-11T10:30:00Z",
          edited_at: null,
        },
      ],
      prev_cursor: null,
      next_cursor: "c1",
    },
    {
      items: [
        {
          type: "event",
          id: 2,
          event_type: "status_changed",
          actor: me,
          payload: { from: "Todo", to: "Done" },
          created_at: "2026-08-11T10:45:00Z",
        },
      ],
      prev_cursor: "c1",
      next_cursor: null,
    },
  ];

  it("stitches the full timeline across pages", async () => {
    let page = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        () => {
          const reply = timelinePages[page];
          page += 1;
          return reply;
        },
      ],
    ]);
    const result = await runCli(["issue", "view", "3", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      issue: { number: number };
      timeline: unknown[];
    };
    expect(parsed.issue.number).toBe(3);
    expect(parsed.timeline).toHaveLength(2);
  });

  it("renders body, comments, and events for humans", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", timelinePages[1]],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("#3 Fix the potato");
    expect(result.stdout).toContain("It sprouted.");
    expect(result.stdout).toContain("status_changed (from=Todo to=Done)");
  });

  it("renders renames and edited markers", async () => {
    const page = {
      items: [
        {
          type: "comment",
          id: 1,
          author: me,
          body: "first",
          created_at: "2026-08-11T10:30:00Z",
          edited_at: "2026-08-11T10:40:00Z",
        },
        {
          type: "event",
          id: 2,
          event_type: "title_changed",
          actor: me,
          payload: { from: "Old potato", to: "Fix the potato" },
          created_at: "2026-08-11T10:45:00Z",
        },
      ],
      prev_cursor: null,
      next_cursor: null,
    };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", page],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("commented (edited)");
    expect(result.stdout).toContain('renamed "Old potato" → "Fix the potato"');
    expect(result.stdout).not.toContain("title_changed (");
  });

  it("rejects a non-numeric issue number", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "view", "abc"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("positive integer");
  });
});

describe("status/label list", () => {
  it("prints statuses ordered by position", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", [statuses[1], statuses[0]]],
    ]);
    const result = await runCli(["status", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout.indexOf("Todo")).toBeLessThan(
      result.stdout.indexOf("Done"),
    );
  });

  it("prints labels", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/labels", labels],
    ]);
    const result = await runCli(["label", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toBe("bug  #ef4444\n");
  });
});

describe("project link/unlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-link-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("errors helpfully outside a repository", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou", { id: 1, slug: "todou" }],
    ]);
    const result = await runCli(["project", "link", "todou"], {
      fetchImpl,
      env: { ...loggedInEnv(), XDG_CONFIG_HOME: dir },
      cwd: dir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no usable git remote");
  });

  it("link verifies the slug and writes the binding; unlink removes it", async () => {
    const repo = join(dir, "repo");
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(repo);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "git@example.com:me/potato.git",
    ]);

    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou", { id: 1, slug: "todou" }],
    ]);
    const env = { ...loggedInEnv(), XDG_CONFIG_HOME: dir };
    const linked = await runCli(["project", "link", "todou"], {
      fetchImpl,
      env,
      cwd: repo,
    });
    expect(linked.exitCode).toBe(0);
    expect(loadCliConfig(env).bindings).toEqual([
      {
        remote: "git@example.com:me/potato.git",
        server: "http://stub.test",
        project: "todou",
      },
    ]);

    const unlinked = await runCli(["project", "unlink"], { env, cwd: repo });
    expect(unlinked.exitCode).toBe(0);
    expect(loadCliConfig(env).bindings).toEqual([]);
  });

  it("unlink reports a missing binding", async () => {
    saveCliConfig({ servers: {}, bindings: [] }, { XDG_CONFIG_HOME: dir });
    const result = await runCli(["project", "unlink"], {
      env: { XDG_CONFIG_HOME: dir },
      cwd: dir,
    });
    expect(result.exitCode).toBe(1);
    expect(loadCliConfig({ XDG_CONFIG_HOME: dir }).bindings).toEqual([]);
  });
});
