import { describe, expect, it } from "vitest";
import {
  fakeFetch,
  loggedInEnv,
  parseNdjson,
  type Route,
  runCli,
} from "./harness.ts";

/**
 * T-134: `--json` consumers only ever saw `"number": 3` and could not tell
 * whether this project writes `#3` or `T-3`. Every issue-shaped payload now
 * carries its spelled `ref`, and every CLI-built envelope states the format
 * outright so an empty page teaches it too.
 */

const me = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  owner: null,
};
const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
  { id: 2, name: "Done", category: "closed", color: "#22c55e", position: 1 },
];
const issue = {
  id: 11,
  number: 3,
  title: "Fix the potato",
  body: "It sprouted.",
  status: statuses[0],
  author: me,
  assignees: [],
  labels: [],
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
};

const prefixed = (prefix: string | null): Route => [
  "GET",
  "/api/projects/todou/references/config",
  { format: { prefix, history: [] }, autolinks: [] },
];

const json = async (argv: string[], routes: Route[]) => {
  const { fetchImpl } = fakeFetch(routes);
  const result = await runCli([...argv, "--json"], {
    fetchImpl,
    env: loggedInEnv(),
  });
  return { result, parsed: JSON.parse(result.stdout) };
};

/** Same, for the watch commands: their `--json` is NDJSON (T-175). */
const ndjson = async <T = Record<string, unknown>>(
  argv: string[],
  routes: Route[],
) => {
  const { fetchImpl } = fakeFetch(routes);
  const result = await runCli([...argv, "--json"], {
    fetchImpl,
    env: loggedInEnv(),
  });
  return { result, ...parseNdjson<T>(result.stdout) };
};

describe("issue JSON carries the project's ref spelling (T-134)", () => {
  it("spells list rows and states the format on the envelope", async () => {
    const { result, parsed } = await json(
      ["issue", "list", "-p", "todou"],
      [
        [
          "GET",
          "/api/projects/todou/issues",
          { items: [issue], next_cursor: null },
        ],
        prefixed("T"),
      ],
    );
    expect(result.exitCode).toBe(0);
    expect(parsed.items[0].number).toBe(3);
    expect(parsed.items[0].ref).toBe("T-3");
    expect(parsed.ref_format).toEqual({ prefix: "T", token: "T-" });
  });

  it("states the format on an empty list, where no ref exists to infer it", async () => {
    const { parsed } = await json(
      ["issue", "list", "-p", "todou"],
      [
        ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
        prefixed("T"),
      ],
    );
    expect(parsed.items).toEqual([]);
    expect(parsed.ref_format).toEqual({ prefix: "T", token: "T-" });
  });

  it("falls back to #N against a server without the config endpoint", async () => {
    const { parsed } = await json(
      ["issue", "list", "-p", "todou"],
      [
        [
          "GET",
          "/api/projects/todou/issues",
          { items: [issue], next_cursor: null },
        ],
      ],
    );
    expect(parsed.items[0].ref).toBe("#3");
    expect(parsed.ref_format).toEqual({ prefix: null, token: "#" });
  });

  it("spells the viewed issue and keeps the cursor beside it", async () => {
    const { parsed } = await json(
      ["issue", "view", "3", "-p", "todou"],
      [
        ["GET", "/api/projects/todou/issues/3", issue],
        [
          "GET",
          "/api/projects/todou/issues/3/timeline",
          { items: [], prev_cursor: null, next_cursor: null },
        ],
        ["PUT", "/api/projects/todou/issues/3/read", {}],
        prefixed("T"),
      ],
    );
    expect(parsed.issue.ref).toBe("T-3");
    expect(parsed.issue.title).toBe("Fix the potato");
    expect(parsed.ref_format).toEqual({ prefix: "T", token: "T-" });
  });

  it("spells the issue that create, edit and close return", async () => {
    const created = await json(
      ["issue", "create", "-p", "todou", "--title", "New", "--body", "b"],
      [
        ["POST", "/api/projects/todou/issues", issue],
        ["GET", "/api/projects/todou/statuses", statuses],
        ["GET", "/api/projects/todou/labels", []],
        prefixed("T"),
      ],
    );
    expect(created.parsed.ref).toBe("T-3");

    const edited = await json(
      ["issue", "edit", "3", "-p", "todou", "--title", "New"],
      [["PATCH", "/api/projects/todou/issues/3", issue], prefixed("T")],
    );
    expect(edited.parsed.ref).toBe("T-3");

    const closed = await json(
      ["issue", "close", "3", "-p", "todou"],
      [
        ["GET", "/api/projects/todou/statuses", statuses],
        ["PATCH", "/api/projects/todou/issues/3", issue],
        prefixed("T"),
      ],
    );
    expect(closed.parsed.ref).toBe("T-3");
  });

  it("names the issue a comment landed on, in the project's spelling", async () => {
    const { parsed } = await json(
      ["comment", "add", "3", "-p", "todou", "--body", "hi"],
      [
        [
          "POST",
          "/api/projects/todou/issues/3/comments",
          { type: "comment", id: 42, body: "hi" },
        ],
        prefixed("T"),
      ],
    );
    expect(parsed.id).toBe(42);
    expect(parsed.issue_number).toBe(3);
    expect(parsed.issue_ref).toBe("T-3");
  });
});

describe("watch JSON carries the ref spelling (T-134)", () => {
  const entry = (id: number, issueNumber: number) => ({
    type: "comment",
    id,
    author: me,
    body: "hello",
    created_at: `2026-08-11T12:00:0${id}.000Z`,
    edited_at: null,
    issue_number: issueNumber,
  });

  it("states the format on `issue watch`, whose entries carry no number", async () => {
    const { result, cursor } = await ndjson(
      ["issue", "watch", "3", "-p", "todou", "--poll", "--since", "c0"],
      [
        ["GET", "/api/me", me],
        [
          "GET",
          "/api/projects/todou/issues/3/timeline",
          { items: [], prev_cursor: null, next_cursor: null },
        ],
        prefixed("T"),
      ],
    );
    expect(result.exitCode).toBe(3);
    expect(cursor.ref_format).toEqual({ prefix: "T", token: "T-" });
  });

  it("spells each single-project activity item beside its issue_number", async () => {
    const { items, cursor } = await ndjson<{
      issue_number: number;
      issue_ref: string;
      project: string;
    }>(
      ["watch", "-p", "todou", "--poll", "--since", "a0"],
      [
        ["GET", "/api/me", me],
        [
          "GET",
          "/api/projects/todou/activity",
          (_init: RequestInit, url: URL) =>
            url.searchParams.get("after") === "a0"
              ? { items: [entry(9, 3)], next_cursor: "a1" }
              : { items: [], next_cursor: null },
        ],
        prefixed("T"),
      ],
    );
    expect(items[0]?.issue_number).toBe(3);
    expect(items[0]?.issue_ref).toBe("T-3");
    expect(items[0]?.project).toBe("todou");
    expect(cursor.ref_format).toEqual({ prefix: "T", token: "T-" });
  });

  it("spells cross-project items per project, and states no single format", async () => {
    const cross = (project: string, issueNumber: number) => ({
      ...entry(1, issueNumber),
      project,
    });
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "env0"
            ? {
                items: [cross("frontend", 7), cross("backend", 4)],
                next_cursor: "env1",
              }
            : { items: [], next_cursor: null },
      ],
      [
        "GET",
        "/api/projects/frontend/references/config",
        { format: { prefix: "F", history: [] }, autolinks: [] },
      ],
      // backend has no config route: it degrades to the bare `#N` form.
    ]);
    const result = await runCli(
      [
        "watch",
        "-p",
        "frontend,backend",
        "--poll",
        "--since",
        "env0",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson<{ issue_ref: string }>(result.stdout);
    expect(items.map((i) => i.issue_ref)).toEqual(["F-7", "#4"]);
    expect(cursor.ref_format).toBeUndefined();
  });
});
