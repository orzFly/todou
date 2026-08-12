import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetch, runCli } from "./harness.ts";

const ENV = {
  TODOU_SERVER: "http://stub.test",
  TODOU_TOKEN: "tok",
  TODOU_PROJECT: "proj",
};

function specDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "todou-spec-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("spec push", () => {
  it("collects .md recursively and posts the whole set", async () => {
    const dir = specDir({
      "design.md": "# D\n",
      "notes/phases.md": "# P\n",
      "q.json": "{}",
    });
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        "/api/projects/proj/issues/23/spec/push",
        {
          unchanged: false,
          version: 1,
          added: ["design.md", "notes/phases.md"],
          changed: [],
          removed: [],
        },
      ],
    ]);
    const run = await runCli(
      ["spec", "push", "23", dir, "--message", "initial"],
      { fetchImpl, env: ENV },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("spec v1 pushed: 2 added");
    expect(run.stderr).toContain("skipped (not .md): q.json");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.message).toBe("initial");
    expect(body.files.map((f: { path: string }) => f.path)).toEqual([
      "design.md",
      "notes/phases.md",
    ]);
  });

  it("reports no-change pushes without inventing a version", async () => {
    const dir = specDir({ "a.md": "x\n" });
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/proj/issues/23/spec/push",
        { unchanged: true, version: 3, added: [], changed: [], removed: [] },
      ],
    ]);
    const run = await runCli(["spec", "push", "23", dir], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("no changes — spec stays at v3");
  });

  it("fails locally, before any request, on an empty directory", async () => {
    const dir = specDir({});
    const { fetchImpl, calls } = fakeFetch([]);
    const run = await runCli(["spec", "push", "23", dir], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("a spec cannot be empty");
    expect(calls).toHaveLength(0);
  });

  it("requires the directory argument", async () => {
    const run = await runCli(["spec", "push", "23"], { env: ENV });
    expect(run.exitCode).not.toBe(0);
  });

  it("passes --if-version through and surfaces the 409 verbatim", async () => {
    const dir = specDir({ "a.md": "x\n" });
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/proj/issues/23/spec/push",
        {
          __status: 409,
          body: {
            error: {
              code: "conflict",
              message: "--if-version 2 does not match the current version v3",
            },
          },
        },
      ],
    ]);
    const run = await runCli(["spec", "push", "23", dir, "--if-version", "2"], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("current version v3");
  });
});

describe("spec pull", () => {
  const SPEC = {
    version: 2,
    files: [
      { path: "design.md", body: "# D v2\n", size: 7 },
      { path: "notes/phases.md", body: "# P\n", size: 4 },
    ],
  };

  it("writes every file, creating nested directories", async () => {
    const dir = specDir({});
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/proj/issues/23/spec/files", SPEC],
    ]);
    const run = await runCli(["spec", "pull", "23", dir], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("pulled spec v2 (2 files)");
    expect(readFileSync(join(dir, "design.md"), "utf8")).toBe("# D v2\n");
    expect(readFileSync(join(dir, "notes/phases.md"), "utf8")).toBe("# P\n");
  });

  it("keeps extra local files unless --prune", async () => {
    const dir = specDir({ "stale.md": "old\n" });
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/proj/issues/23/spec/files", SPEC],
    ]);
    const kept = await runCli(["spec", "pull", "23", dir], {
      fetchImpl,
      env: ENV,
    });
    expect(kept.stderr).toContain("kept local file not in spec: stale.md");
    expect(existsSync(join(dir, "stale.md"))).toBe(true);

    const pruned = await runCli(["spec", "pull", "23", dir, "--prune"], {
      fetchImpl,
      env: ENV,
    });
    expect(pruned.stderr).toContain("pruned stale.md");
    expect(existsSync(join(dir, "stale.md"))).toBe(false);
  });
});

describe("spec status", () => {
  it("renders version, review state, and files", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/proj/issues/23/spec",
        {
          current_version: 2,
          review_status: "unreviewed",
          unresolved_comments: 0,
          files: [{ path: "design.md", size: 7 }],
          versions: [
            {
              number: 1,
              author: { id: 2, login: "claude-agent" },
              message: null,
              created_at: "2026-08-12T05:00:00.000Z",
            },
            {
              number: 2,
              author: { id: 2, login: "claude-agent" },
              message: "address review",
              created_at: "2026-08-12T06:00:00.000Z",
            },
          ],
        },
      ],
    ]);
    const run = await runCli(["spec", "status", "23"], { fetchImpl, env: ENV });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("spec v2 · awaiting review");
    expect(run.stdout).toContain("design.md (7 bytes)");
    expect(run.stdout).toContain("v2 by claude-agent");
    expect(run.stdout).toContain("address review");
  });
});

describe("spec comments", () => {
  const COMMENTS = {
    current_version: 2,
    items: [
      {
        comment_id: 412,
        author: { id: 1, login: "user" },
        created_at: "2026-08-12T06:10:00.000Z",
        body: "Which diff library?",
        anchor: {
          path: "design.md",
          version: 1,
          line_start: 3,
          line_end: 4,
          quote: "Anchors point at…\nResolve is one-way.",
        },
        resolved: null,
        outdated: true,
        current_line_start: null,
        current_line_end: null,
      },
      {
        comment_id: 415,
        author: { id: 1, login: "user" },
        created_at: "2026-08-12T06:11:00.000Z",
        body: "Louder in the intro.",
        anchor: {
          path: "notes/phases.md",
          version: 2,
          line_start: 5,
          line_end: 5,
          quote: "Phase one ships push.",
        },
        resolved: {
          by: { id: 2, login: "claude-agent" },
          at: "2026-08-12T07:00:00.000Z",
        },
        outdated: false,
        current_line_start: 5,
        current_line_end: 5,
      },
    ],
  };

  it("renders anchors, quotes, and resolution flags", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/proj/issues/23/spec/comments", COMMENTS],
    ]);
    const run = await runCli(["spec", "comments", "23"], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      "#412 design.md:3-4 (v1) by user · unresolved, outdated",
    );
    expect(run.stdout).toContain("  > Anchors point at…");
    expect(run.stdout).toContain(
      "#415 notes/phases.md:5-5 (v2) by user · resolved by claude-agent",
    );
  });

  it("--unresolved and --file filter locally", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/proj/issues/23/spec/comments", COMMENTS],
    ]);
    const run = await runCli(
      ["spec", "comments", "23", "--unresolved", "--json"],
      { fetchImpl, env: ENV },
    );
    const data = JSON.parse(run.stdout);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].comment_id).toBe(412);

    const byFile = await runCli(
      ["spec", "comments", "23", "--file", "notes/phases.md", "--json"],
      { fetchImpl, env: ENV },
    );
    expect(
      JSON.parse(byFile.stdout).items.map(
        (i: { comment_id: number }) => i.comment_id,
      ),
    ).toEqual([415]);
  });
});

describe("spec resolve", () => {
  it("posts every id in one request", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        "/api/projects/proj/issues/23/spec/comments/resolve",
        { resolved: [412, 415] },
      ],
    ]);
    const run = await runCli(["spec", "resolve", "23", "412", "#415"], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("resolved 2 comment(s)");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      comment_ids: [412, 415],
    });
  });

  it("rejects non-numeric ids before any request", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const run = await runCli(["spec", "resolve", "23", "nope"], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("spec review", () => {
  it("requires exactly one verdict", async () => {
    const both = await runCli(
      ["spec", "review", "23", "--approve", "--request-changes"],
      { env: ENV },
    );
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("exactly one verdict");
    const neither = await runCli(["spec", "review", "23"], { env: ENV });
    expect(neither.exitCode).toBe(1);
  });

  it("fetches the current version and submits the verdict", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        "/api/projects/proj/issues/23/spec",
        {
          current_version: 3,
          review_status: "unreviewed",
          unresolved_comments: 0,
          files: [],
          versions: [],
        },
      ],
      [
        "POST",
        "/api/projects/proj/issues/23/spec/reviews",
        {
          event_id: 99,
          version: 3,
          verdict: "request_changes",
          summary_comment_id: 88,
          comment_ids: [],
        },
      ],
    ]);
    const run = await runCli(
      ["spec", "review", "23", "--request-changes", "--body", "rework §2"],
      { fetchImpl, env: ENV },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("requested changes on spec v3");
    const posted = JSON.parse(String(calls[1]?.init.body));
    expect(posted).toMatchObject({
      version: 3,
      verdict: "request_changes",
      body: "rework §2",
      comments: [],
    });
  });
});
