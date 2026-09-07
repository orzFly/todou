import { describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  avatar_url: null,
  owner: null,
};

const entry = (
  namespace: string,
  key: string,
  value: string,
  updated_at = "2026-09-07T10:00:00Z",
) => ({ namespace, key, value, updated_at, updated_by: me });

function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const READ = "/api/projects/todou/issues/282/metadata";

/**
 * The metadata command group (T-282). The main consumer is an agent running
 * this CLI, so what these pin is the argument surface and the exit codes, not
 * the prose.
 */
describe("todou metadata", () => {
  const env = loggedInEnv("todou");

  it("groups what it reads by namespace", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        READ,
        {
          entries: [
            entry("ci", "run", "green"),
            entry("orch", "owner", "planner"),
            entry("orch", "phase", "plan"),
          ],
        },
      ],
    ]);
    const res = await runCli(["metadata", "get", "282"], { fetchImpl, env });
    expect(res.exitCode).toBe(0);
    // No `--namespace` reads everything, the way `attach list` does.
    expect(calls[0]?.url).toContain("namespace=*");
    expect(res.stdout).toContain("ci:");
    expect(res.stdout).toContain("orch:");
    expect(res.stdout.indexOf("ci:")).toBeLessThan(res.stdout.indexOf("orch:"));
    expect(res.stdout).toContain("green");
    expect(res.stdout).toContain("Claude");
  });

  it("passes the namespaces it was given", async () => {
    const { fetchImpl, calls } = fakeFetch([["GET", READ, { entries: [] }]]);
    const res = await runCli(
      ["metadata", "get", "282", "--namespace", "orch,ci"],
      { fetchImpl, env },
    );
    expect(res.exitCode).toBe(0);
    expect(new URL(calls[0]?.url as string).searchParams.get("namespace")).toBe(
      "orch,ci",
    );
    expect(res.stdout.trim()).toBe("no metadata");
  });

  it("indents a value that carries newlines", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", READ, { entries: [entry("ci", "report", '{\n  "ok": true\n}')] }],
    ]);
    const res = await runCli(["metadata", "get", "282"], { fetchImpl, env });
    expect(res.stdout).toContain('    {\n      "ok": true\n    }');
  });

  it("lists namespaces with their size", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        `${READ}/namespaces`,
        {
          namespaces: [
            { namespace: "ci", keys: 1, updated_at: "2026-09-07T10:00:00Z" },
            { namespace: "orch", keys: 2, updated_at: "2026-09-07T10:00:00Z" },
          ],
        },
      ],
    ]);
    const res = await runCli(["metadata", "namespaces", "282"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("1 key");
    expect(res.stdout).toContain("2 keys");
  });

  it("writes key=value positionals", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["PATCH", READ, { entries: [entry("orch", "phase", "impl")] }],
    ]);
    const res = await runCli(
      [
        "metadata",
        "set",
        "282",
        "--namespace",
        "orch",
        "phase=impl",
        "owner=agent-1",
      ],
      { fetchImpl, env },
    );
    expect(res.exitCode).toBe(0);
    expect(jsonBody(calls[0]?.init as RequestInit)).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: "impl" },
        { namespace: "orch", key: "owner", value: "agent-1" },
      ],
    });
  });

  it("splits a value on its first `=` only", async () => {
    const { fetchImpl, calls } = fakeFetch([["PATCH", READ, { entries: [] }]]);
    await runCli(
      ["metadata", "set", "282", "--namespace", "ci", "cmd=a=b", "blank="],
      { fetchImpl, env },
    );
    expect(jsonBody(calls[0]?.init as RequestInit)).toEqual({
      entries: [
        { namespace: "ci", key: "cmd", value: "a=b" },
        // The empty string is a value; deleting is `metadata unset`.
        { namespace: "ci", key: "blank", value: "" },
      ],
    });
  });

  it("reads one value from stdin", async () => {
    const { fetchImpl, calls } = fakeFetch([["PATCH", READ, { entries: [] }]]);
    const res = await runCli(
      [
        "metadata",
        "set",
        "282",
        "--namespace",
        "ci",
        "--key",
        "report",
        "--value-file",
        "-",
      ],
      { fetchImpl, env, stdinText: "line one\nline two\n" },
    );
    expect(res.exitCode).toBe(0);
    expect(jsonBody(calls[0]?.init as RequestInit)).toEqual({
      entries: [
        { namespace: "ci", key: "report", value: "line one\nline two\n" },
      ],
    });
  });

  it("maps the two expectation flags onto the three states", async () => {
    const { fetchImpl, calls } = fakeFetch([["PATCH", READ, { entries: [] }]]);
    await runCli(
      [
        "metadata",
        "set",
        "282",
        "--namespace",
        "orch",
        "phase=impl",
        "owner=agent-1",
        "note=x",
        "--if-match",
        "phase=plan",
        "--if-absent",
        "owner",
      ],
      { fetchImpl, env },
    );
    expect(jsonBody(calls[0]?.init as RequestInit)).toEqual({
      entries: [
        // A stated value.
        { namespace: "orch", key: "phase", value: "impl", if_match: "plan" },
        // Expected to be absent, which is null and not the empty string.
        { namespace: "orch", key: "owner", value: "agent-1", if_match: null },
        // No expectation at all: the key is simply absent from the entry.
        { namespace: "orch", key: "note", value: "x" },
      ],
    });
  });

  it("keeps `--if-match key=` as the empty string", async () => {
    const { fetchImpl, calls } = fakeFetch([["PATCH", READ, { entries: [] }]]);
    await runCli(
      [
        "metadata",
        "set",
        "282",
        "--namespace",
        "orch",
        "phase=impl",
        "--if-match",
        "phase=",
      ],
      { fetchImpl, env },
    );
    expect(
      (jsonBody(calls[0]?.init as RequestInit).entries as unknown[])[0],
    ).toEqual({
      namespace: "orch",
      key: "phase",
      value: "impl",
      if_match: "",
    });
  });

  it("reports a lost race and exits 1", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "PATCH",
        READ,
        {
          __status: 409,
          body: {
            error: {
              code: "metadata_precondition",
              message: "if_match did not hold for orch/owner",
              details: {
                failed: [
                  { namespace: "orch", key: "owner", current: "agent-2" },
                ],
              },
            },
          },
        },
      ],
    ]);
    const res = await runCli(
      [
        "metadata",
        "set",
        "282",
        "--namespace",
        "orch",
        "owner=agent-1",
        "--if-absent",
        "owner",
      ],
      { fetchImpl, env },
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("nothing written");
    expect(res.stderr).toContain('orch/owner is "agent-2"');
  });

  it("deletes with unset", async () => {
    const { fetchImpl, calls } = fakeFetch([["PATCH", READ, { entries: [] }]]);
    const res = await runCli(
      ["metadata", "unset", "282", "--namespace", "orch", "phase", "owner"],
      { fetchImpl, env },
    );
    expect(res.exitCode).toBe(0);
    expect(jsonBody(calls[0]?.init as RequestInit)).toEqual({
      entries: [
        { namespace: "orch", key: "phase", value: null },
        { namespace: "orch", key: "owner", value: null },
      ],
    });
  });

  it("refuses a namespace or key the server would refuse anyway", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const bad = await runCli(
      ["metadata", "set", "282", "--namespace", "Orch", "phase=x"],
      { fetchImpl, env },
    );
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("is not a namespace");

    const badKey = await runCli(
      ["metadata", "set", "282", "--namespace", "orch", "Phase=x"],
      { fetchImpl, env },
    );
    expect(badKey.exitCode).not.toBe(0);
    expect(badKey.stderr).toContain("is not a key");
    // Caught before the request, so a typo costs no round trip.
    expect(calls).toEqual([]);
  });

  it("refuses an expectation on a key it does not write", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const res = await runCli(
      [
        "metadata",
        "set",
        "282",
        "--namespace",
        "orch",
        "phase=impl",
        "--if-match",
        "owner=agent-1",
      ],
      { fetchImpl, env },
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("which this command does not write");
    expect(calls).toEqual([]);
  });
});

describe("issue view/list --metadata", () => {
  const env = loggedInEnv("todou");
  const statuses = [
    { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
  ];
  const card = (metadata?: unknown) => ({
    id: 11,
    number: 282,
    title: "a card with state on it",
    body: "the body",
    status: statuses[0],
    author: me,
    assignees: [],
    labels: [],
    created_at: "2026-09-07T10:00:00Z",
    updated_at: "2026-09-07T11:00:00Z",
    ...(metadata === undefined ? {} : { metadata }),
  });

  const viewRoutes = (reply: (url: URL) => unknown): Route[] => [
    [
      "GET",
      "/api/projects/todou/issues/282",
      (_init: RequestInit, url: URL) => reply(url),
    ],
    [
      "GET",
      "/api/projects/todou/issues/282/timeline",
      { items: [], next_cursor: null },
    ],
    ["GET", "/api/projects/todou/references", { prefix: "T", autolinks: [] }],
    ["GET", "/api/projects", []],
    ["PUT", "/api/projects/todou/issues/282/read", { __status: 204 }],
  ];

  it("says nothing about metadata unless asked", async () => {
    const { fetchImpl, calls } = fakeFetch(viewRoutes(() => card()));
    const res = await runCli(["issue", "view", "282"], { fetchImpl, env });
    expect(res.exitCode).toBe(0);
    // The negative that matters: the flag's absence has to leave the old
    // output and the old request untouched.
    expect(res.stdout.toLowerCase()).not.toContain("metadata");
    expect(calls.some((c) => c.url.includes("metadata"))).toBe(false);
  });

  it("prints a metadata section when asked", async () => {
    const { fetchImpl, calls } = fakeFetch(
      viewRoutes((url) =>
        card(
          url.searchParams.get("metadata") === null
            ? undefined
            : [entry("orch", "phase", "plan")],
        ),
      ),
    );
    const res = await runCli(["issue", "view", "282", "--metadata", "orch"], {
      fetchImpl,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(calls.some((c) => c.url.includes("metadata=orch"))).toBe(true);
    expect(res.stdout).toContain("── metadata ──");
    expect(res.stdout).toContain("phase");
    expect(res.stdout).toContain("plan");
  });

  it("adds a column to the list only when asked", async () => {
    const listRoutes = (items: unknown[]): Route[] => [
      ["GET", "/api/projects/todou/issues", { items, next_cursor: null }],
      ["GET", "/api/projects/todou/references", { prefix: "T", autolinks: [] }],
    ];

    const plain = fakeFetch(listRoutes([card()]));
    const bare = await runCli(["issue", "list"], {
      fetchImpl: plain.fetchImpl,
      env,
    });
    expect(bare.stdout).not.toContain("orch/");
    expect(plain.calls.some((c) => c.url.includes("metadata"))).toBe(false);

    const asked = fakeFetch(
      listRoutes([card([entry("orch", "phase", "plan")])]),
    );
    const withColumn = await runCli(["issue", "list", "--metadata", "*"], {
      fetchImpl: asked.fetchImpl,
      env,
    });
    expect(withColumn.stdout).toContain("orch/phase=plan");
    expect(asked.calls.some((c) => c.url.includes("metadata=*"))).toBe(true);
  });
});
