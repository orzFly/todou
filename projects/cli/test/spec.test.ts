import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPEC_MAX_FILE_CHARS, SPEC_MAX_FILES } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { fakeFetch, type Route, runCli } from "./harness.ts";

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

  it("fails during collection, before any request, past the file cap", async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i <= SPEC_MAX_FILES; i++) {
      tree[`f${String(i).padStart(3, "0")}.md`] = "x\n";
    }
    const dir = specDir(tree);
    const { fetchImpl, calls } = fakeFetch([]);
    const run = await runCli(["spec", "push", "23", dir], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      `more than ${SPEC_MAX_FILES} markdown files under ${dir}`,
    );
    // the name-ordered walk pins which file gets blamed
    expect(run.stderr).toContain(
      `collection stopped at f${String(SPEC_MAX_FILES).padStart(3, "0")}.md`,
    );
    expect(run.stderr).toContain("not a repository root");
    expect(calls).toHaveLength(0);
  });

  it("still pushes a set of exactly SPEC_MAX_FILES files", async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i < SPEC_MAX_FILES; i++) {
      tree[`f${String(i).padStart(3, "0")}.md`] = "x\n";
    }
    const dir = specDir(tree);
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        "/api/projects/proj/issues/23/spec/push",
        { unchanged: false, version: 1, added: [], changed: [], removed: [] },
      ],
    ]);
    const run = await runCli(["spec", "push", "23", dir], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(0);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.files).toHaveLength(SPEC_MAX_FILES);
  });

  it("fails during collection on a file over the per-file cap", async () => {
    const dir = specDir({
      // walked first (name order) and exactly at the cap: proves > not >=
      "at-cap.md": "x".repeat(SPEC_MAX_FILE_CHARS),
      "over.md": "x".repeat(SPEC_MAX_FILE_CHARS + 1),
    });
    const { fetchImpl, calls } = fakeFetch([]);
    const run = await runCli(["spec", "push", "23", dir], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("over.md is over the spec file cap");
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

  it("lists any number of extras — the push caps do not apply to pull", async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i <= SPEC_MAX_FILES; i++) {
      tree[`extra-${String(i).padStart(3, "0")}.md`] = "old\n";
    }
    const dir = specDir(tree);
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/proj/issues/23/spec/files", SPEC],
    ]);
    const run = await runCli(["spec", "pull", "23", dir], {
      fetchImpl,
      env: ENV,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("pulled spec v2 (2 files)");
    expect(run.stderr).toContain("kept local file not in spec: extra-000.md");
    expect(run.stderr).toContain(
      `kept local file not in spec: extra-${String(SPEC_MAX_FILES).padStart(3, "0")}.md`,
    );
  });
});

describe("spec list (T-184)", () => {
  const author = { id: 2, login: "claude-agent", display_name: "Claude Agent" };
  const row = (
    number: number,
    title: string,
    spec: Record<string, unknown>,
    statusName = "In Progress",
  ) => ({
    id: number * 10,
    number,
    title,
    status: {
      id: 1,
      name: statusName,
      category: "open",
      color: "#3b82f6",
      position: 0,
    },
    author,
    assignees: [],
    labels: [],
    created_at: "2026-08-12T05:00:00.000Z",
    updated_at: "2026-08-12T06:00:00.000Z",
    body_edited_at: null,
    spec_version: null,
    spec_review_status: null,
    spec_unresolved_comments: 0,
    ...spec,
  });

  it("keeps the cards with a spec and drops the ones without", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/proj/issues",
        {
          items: [
            row(23, "Sprout the potato", {
              spec_version: 3,
              spec_review_status: "unreviewed",
              spec_unresolved_comments: 2,
            }),
            row(9, "No spec here", {}),
            row(24, "Water the field", {
              spec_version: 5,
              spec_review_status: "approved",
            }),
          ],
          next_cursor: null,
        },
      ],
    ]);
    const run = await runCli(["spec", "list"], { fetchImpl, env: ENV });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("No spec here");
    const line = (n: number) =>
      run.stdout.split("\n").find((l) => l.startsWith(`#${n} `));
    expect(line(23)).toContain("v3");
    expect(line(23)).toContain("awaiting review");
    expect(line(23)).toContain("2 unresolved");
    expect(line(24)).toContain("v5");
    expect(line(24)).toContain("approved");
    // Zero unresolved is the quiet case; the column stays empty for it.
    expect(line(24)).not.toContain("unresolved");
    expect(run.stdout.trimEnd().split("\n").at(-1)).toBe("2 specs");
  });

  it("asks for open cards by default and drops the filter on --state all", async () => {
    const seen: string[] = [];
    const routes = (): Route[] => [
      [
        "GET",
        "/api/projects/proj/issues",
        (_init: RequestInit, url: URL) => {
          seen.push(url.searchParams.get("category") ?? "(none)");
          return { items: [], next_cursor: null };
        },
      ],
    ];
    const { fetchImpl } = fakeFetch(routes());
    await runCli(["spec", "list"], { fetchImpl, env: ENV });
    await runCli(["spec", "list", "--state", "closed"], {
      fetchImpl,
      env: ENV,
    });
    await runCli(["spec", "list", "--state", "all"], { fetchImpl, env: ENV });
    expect(seen).toEqual(["open", "closed", "(none)"]);
  });

  it("drains every page", async () => {
    let page = 0;
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/proj/issues",
        () => {
          page += 1;
          return page === 1
            ? {
                items: [row(1, "First page", { spec_version: 1 })],
                next_cursor: "p2",
              }
            : {
                items: [row(2, "Second page", { spec_version: 2 })],
                next_cursor: null,
              };
        },
      ],
    ]);
    const run = await runCli(["spec", "list"], { fetchImpl, env: ENV });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("First page");
    expect(run.stdout).toContain("Second page");
  });

  it("points an empty default listing at the closed cards", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/proj/issues", { items: [], next_cursor: null }],
    ]);
    const open = await runCli(["spec", "list"], { fetchImpl, env: ENV });
    expect(open.exitCode).toBe(0);
    expect(open.stdout).toBe(
      "no specs\n--state all also looks at closed cards\n",
    );

    const all = await runCli(["spec", "list", "--state", "all"], {
      fetchImpl,
      env: ENV,
    });
    expect(all.stdout).toBe("no specs\n");
  });

  it("emits the filtered rows under --json", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/proj/issues",
        {
          items: [
            row(23, "Sprout the potato", { spec_version: 3 }),
            row(9, "No spec here", {}),
          ],
          next_cursor: null,
        },
      ],
    ]);
    const run = await runCli(["spec", "list", "--json"], {
      fetchImpl,
      env: ENV,
    });
    const parsed = JSON.parse(run.stdout) as {
      items: Array<{ number: number; ref: string }>;
      ref_format: unknown;
    };
    expect(Object.keys(parsed).sort()).toEqual(["items", "ref_format"]);
    expect(parsed.items.map((i) => i.number)).toEqual([23]);
    expect(parsed.items[0]?.ref).toBe("#23");
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
              author: {
                id: 2,
                login: "claude-agent",
                display_name: "Claude Agent",
              },
              message: null,
              created_at: "2026-08-12T05:00:00.000Z",
            },
            {
              number: 2,
              author: {
                id: 2,
                login: "claude-agent",
                display_name: "Claude Agent",
              },
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
    expect(run.stdout).toContain("v2 by Claude Agent");
    expect(run.stdout).toContain("address review");
  });
});

describe("spec comments", () => {
  const COMMENTS = {
    current_version: 2,
    items: [
      {
        comment_id: 412,
        author: { id: 1, login: "user", display_name: "Sam Reviewer" },
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
        author: { id: 1, login: "user", display_name: "Sam Reviewer" },
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
          by: { id: 2, login: "claude-agent", display_name: "Claude Agent" },
          at: "2026-08-12T07:00:00.000Z",
        },
        outdated: false,
        current_line_start: 5,
        current_line_end: 5,
      },
      {
        comment_id: 419,
        author: { id: 1, login: "user" },
        created_at: "2026-08-12T06:12:00.000Z",
        body: "This clause.",
        anchor: {
          path: "design.md",
          version: 2,
          line_start: 7,
          line_end: 7,
          col_start: 12,
          col_end: 34,
          quote: "half of a sentence",
        },
        resolved: null,
        outdated: false,
        current_line_start: 7,
        current_line_end: 7,
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
      "#412 design.md:3-4 (v1) by Sam Reviewer · unresolved, outdated",
    );
    expect(run.stdout).toContain("  > Anchors point at…");
    expect(run.stdout).toContain(
      "#415 notes/phases.md:5-5 (v2) by Sam Reviewer · resolved by Claude Agent",
    );
    // Column-anchored comments spell `line.column` on each end (T-142);
    // the two above carry no columns and keep the plain line form.
    // #419's author carries no display_name — the shape an older server
    // sends — and falls back to the login (T-149).
    expect(run.stdout).toContain("#419 design.md:7.12-7.34 (v2) by user");
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
    expect(data.items.map((i: { comment_id: number }) => i.comment_id)).toEqual(
      [412, 419],
    );

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

/**
 * T-182: the push used to hand the pusher nothing, so the review gate took
 * its cursor afterwards and could not see a verdict that landed in between.
 */
describe("spec push cursor", () => {
  const me = {
    id: 2,
    login: "claude-agent",
    display_name: "Claude Agent",
    kind: "machine",
    owner: null,
  };
  const CURSOR = "3:hlsw2ffv8g.1.3pz";

  const pushRoute = (cursor: string | undefined): Route => [
    "POST",
    "/api/projects/proj/issues/23/spec/push",
    {
      unchanged: false,
      version: 2,
      added: [],
      changed: ["design.md"],
      removed: [],
      ...(cursor === undefined ? {} : { cursor }),
    },
  ];
  const reviewComment = {
    type: "comment",
    id: 41,
    author: { id: 3, login: "user", display_name: "User", kind: "human" },
    body: "hold on, one more thing",
    component: null,
    created_at: "2026-08-11T12:00:00Z",
    edited_at: null,
    resolved_at: null,
    agent_context: null,
  };
  const gapRoutes = (items: unknown[]): Route[] => [
    ["GET", "/api/me", me],
    [
      "GET",
      "/api/projects/proj/issues/23/timeline",
      { items, next_cursor: items.length === 0 ? null : "3:z.0.29" },
    ],
    [
      "GET",
      "/api/projects/proj/references/config",
      { format: { prefix: "T", history: [] }, autolinks: [] },
    ],
  ];

  const push = async (argv: string[], routes: Route[]) => {
    const { fetchImpl, calls } = fakeFetch(routes);
    const run = await runCli(
      ["spec", "push", "23", specDir({ "design.md": "x\n" }), ...argv],
      { fetchImpl, env: ENV },
    );
    return { run, calls };
  };

  it("closes the human output with the cursor to wait from", async () => {
    const { run } = await push([], [pushRoute(CURSOR)]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trimEnd().split("\n").at(-1)).toBe(
      `cursor: ${CURSOR} (issue watch --since <cursor>)`,
    );
  });

  it("--print-cursor leaves stdout to the cursor and nothing else", async () => {
    const { run } = await push(["--print-cursor"], [pushRoute(CURSOR)]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(`${CURSOR}\n`);
    expect(run.stderr).toContain("spec v2 pushed");
  });

  it("--print-cursor and --json both want stdout, so neither pushes", async () => {
    const { run, calls } = await push(
      ["--print-cursor", "--json"],
      [pushRoute(CURSOR)],
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("both want stdout");
    // The clash is caught before the write: a rejected flag pair must not
    // leave a spec version behind.
    expect(calls).toHaveLength(0);
  });

  it("--json carries the cursor as a field", async () => {
    const { run } = await push(["--json"], [pushRoute(CURSOR)]);
    expect(JSON.parse(run.stdout)).toMatchObject({
      version: 2,
      cursor: CURSOR,
    });
  });

  it("--since echoes the given cursor and reports the gap on stderr", async () => {
    const { run } = await push(
      ["--since", "3:old.0.1"],
      [pushRoute(CURSOR), ...gapRoutes([reviewComment])],
    );
    expect(run.exitCode).toBe(0);
    // The echo, not the server's newer position: everything just reported
    // is still ahead of it, so a watch resuming there replays it.
    expect(run.stdout).toContain("cursor: 3:old.0.1 ");
    expect(run.stdout).not.toContain(CURSOR);
    expect(run.stderr).toContain("1 entry landed since --since");
    expect(run.stderr).toContain("hold on, one more thing");
  });

  it("--json --since reports the gap as missed", async () => {
    const { run } = await push(
      ["--json", "--since", "3:old.0.1"],
      [pushRoute(CURSOR), ...gapRoutes([reviewComment])],
    );
    const parsed = JSON.parse(run.stdout);
    expect(parsed.cursor).toBe("3:old.0.1");
    expect(parsed.missed.map((i: { id: number }) => i.id)).toEqual([41]);
  });

  it("says nothing extra when the gap is empty", async () => {
    const { run } = await push(
      ["--json", "--since", "3:old.0.1"],
      [pushRoute(CURSOR), ...gapRoutes([])],
    );
    expect(JSON.parse(run.stdout).missed).toEqual([]);
    expect(run.stderr).not.toContain("landed since");
  });

  it("drops the cursor line against a server that mints none", async () => {
    const { run } = await push([], [pushRoute(undefined)]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(
      "spec v2 pushed: 0 added, 1 changed, 0 removed\n  ~ design.md\n",
    );
  });

  it("--print-cursor says so when the server minted none", async () => {
    const { run } = await push(["--print-cursor"], [pushRoute(undefined)]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("no cursor to print");
    // The push happened; its summary must still reach the caller.
    expect(run.stderr).toContain("spec v2 pushed");
  });

  it("refuses an empty --since before the push runs", async () => {
    const { run, calls } = await push(["--since", ""], [pushRoute(CURSOR)]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("empty cursor");
    expect(calls).toHaveLength(0);
  });
});
