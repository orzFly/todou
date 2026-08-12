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
