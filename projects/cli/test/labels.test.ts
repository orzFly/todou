import { describe, expect, it } from "vitest";
import { labelColorFor } from "../src/resolve.ts";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};
const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
];
const bug = { id: 7, name: "bug", color: "#ef4444" };
const chore = { id: 8, name: "chore", color: "#3b82f6" };

function issueWith(overrides: Record<string, unknown>) {
  return {
    id: 11,
    number: 3,
    title: "Fix the potato",
    body: "",
    status: statuses[0],
    author: me,
    assignees: [],
    labels: [],
    created_at: "2026-08-11T10:00:00Z",
    updated_at: "2026-08-11T11:00:00Z",
    ...overrides,
  };
}

function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/**
 * A label table that grows as the CLI creates labels, so a command that
 * lists, creates, then lists again sees its own writes — which is exactly
 * what the 409 adoption path and the repeat-within-one-command path do.
 */
function labelStore(
  initial: Array<{ id: number; name: string; color: string }>,
) {
  const rows = [...initial];
  let nextId = Math.max(0, ...rows.map((r) => r.id)) + 1;
  const created: Array<{ name: string; color: string }> = [];
  const routes: Route[] = [
    ["GET", "/api/projects/todou/labels", () => [...rows]],
    [
      "POST",
      "/api/projects/todou/labels",
      (init: RequestInit) => {
        const input = jsonBody(init) as { name: string; color: string };
        created.push(input);
        if (rows.some((r) => r.name === input.name)) {
          return {
            __status: 409,
            body: { error: { code: "conflict", message: "label exists" } },
          };
        }
        const row = { id: nextId++, name: input.name, color: input.color };
        rows.push(row);
        return row;
      },
    ],
  ];
  return { routes, rows, created };
}

describe("label auto-creation (T-135)", () => {
  it("creates what issue create does not find, and says so on stderr", async () => {
    const store = labelStore([]);
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ...store.routes,
      [
        "POST",
        "/api/projects/todou/issues",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return issueWith({ number: 9, title: "New one" });
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "create",
        "--title",
        "New one",
        "--body",
        "x",
        "--label",
        "area:infra",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(store.created).toEqual([
      { name: "area:infra", color: labelColorFor("area:infra") },
    ]);
    expect(posted?.label_ids).toEqual([1]);
    // stdout stays data-only; the notice is stderr, and it carries the fix.
    expect(result.stdout).toBe("#9 created: New one\n");
    expect(result.stderr).toContain("created label 'area:infra'");
    expect(result.stderr).toContain(
      "todou label edit 'area:infra' -p todou --color '#rrggbb'",
    );
  });

  it("creates each new name once, however often it is repeated", async () => {
    const store = labelStore([]);
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ...store.routes,
      ["GET", "/api/projects/todou/issues/3", issueWith({})],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({});
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "edit", "3", "--add-label", "a,a", "--add-label", "a"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(store.created).toHaveLength(1);
    expect(patched).toEqual({ label_ids: [1] });
  });

  it("adopts a label a sibling command created first", async () => {
    // The store answers the first GET before the sibling's insert lands, so
    // the POST comes back 409 and the code has to re-read to find the id.
    const rows = [{ ...bug }];
    let listed = 0;
    let created = 0;
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/labels",
        () => {
          listed += 1;
          return listed === 1 ? [bug] : rows;
        },
      ],
      [
        "POST",
        "/api/projects/todou/labels",
        () => {
          created += 1;
          rows.push({ id: 12, name: "kind:chore", color: "#000000" });
          return {
            __status: 409,
            body: { error: { code: "conflict", message: "label exists" } },
          };
        },
      ],
      [
        "POST",
        "/api/projects/todou/issues",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return issueWith({ number: 9 });
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "create", "--title", "T", "--body", "x", "-l", "kind:chore"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(created).toBe(1);
    expect(posted?.label_ids).toEqual([12]);
  });

  it("explains the admin role when creation is forbidden", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/labels", [bug]],
      [
        "POST",
        "/api/projects/todou/labels",
        {
          __status: 403,
          body: {
            error: { code: "forbidden", message: "requires admin role" },
          },
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "create", "--title", "T", "--body", "x", "-l", "needs-triage"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("needs the admin role");
    expect(result.stderr).toContain("todou label create 'needs-triage'");
  });

  it("keeps list filters strict — an unknown label there is a typo", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/labels", [bug]],
    ]);
    const result = await runCli(["issue", "list", "--label", "aera:cli"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown label "aera:cli"');
    expect(calls.every((c) => c.init.method !== "POST")).toBe(true);
  });

  it("matches a stored name through a differently spaced spelling", async () => {
    // The server canonicalizes whitespace (T-136), so the CLI has to ask
    // for the canonical spelling — otherwise this misses, tries to create
    // a label that exists, and surfaces a bare 409.
    const spaced = { id: 21, name: "area: cli", color: "#3b82f6" };
    const store = labelStore([spaced]);
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ...store.routes,
      ["GET", "/api/projects/todou/issues/3", issueWith({})],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({});
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "edit", "3", "--add-label", "  area:   cli "],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(store.created).toEqual([]);
    expect(patched).toEqual({ label_ids: [21] });
  });

  it("creates the canonical spelling, not the one that was typed", async () => {
    const store = labelStore([]);
    const { fetchImpl } = fakeFetch([
      ...store.routes,
      ["POST", "/api/projects/todou/issues", () => issueWith({ number: 9 })],
    ]);
    const result = await runCli(
      ["issue", "create", "-t", "T", "-b", "x", "-l", "area:   cli"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(store.created.map((c) => c.name)).toEqual(["area: cli"]);
  });

  it("keeps --remove-label strict too", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issueWith({ labels: [bug] })],
      ["GET", "/api/projects/todou/labels", [bug]],
    ]);
    const result = await runCli(
      ["issue", "edit", "3", "--remove-label", "gone"],
      {
        fetchImpl,
        env: loggedInEnv("todou"),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown label "gone"');
  });
});

describe("labelColorFor", () => {
  it("is stable per name and spreads names across the palette", () => {
    expect(labelColorFor("area:cli")).toBe(labelColorFor("area:cli"));
    expect(labelColorFor("area:cli")).toMatch(/^#[0-9a-f]{6}$/);
    const spread = new Set(
      ["area:cli", "area:web", "kind:bug", "kind:feature", "需要停机"].map(
        labelColorFor,
      ),
    );
    expect(spread.size).toBeGreaterThan(1);
  });
});

describe("issue edit --labels replaces the set (T-135)", () => {
  it("drops what it does not name, and names what it dropped", async () => {
    const store = labelStore([bug, chore]);
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ...store.routes,
      [
        "GET",
        "/api/projects/todou/issues/3",
        issueWith({ labels: [bug, chore] }),
      ],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({ labels: [chore] });
        },
      ],
    ]);
    const result = await runCli(["issue", "edit", "3", "--labels", "chore"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ label_ids: [8] });
    expect(result.stderr).toContain(
      "--label/--labels replaces the whole label set — removed bug",
    );
    expect(result.stderr).toContain(
      "to add without replacing: todou issue edit 3 -p todou --add-label 'bug'",
    );
  });

  it("says nothing extra when the replacement drops nothing", async () => {
    const store = labelStore([bug, chore]);
    const { fetchImpl } = fakeFetch([
      ...store.routes,
      ["GET", "/api/projects/todou/issues/3", issueWith({ labels: [bug] })],
      ["PATCH", "/api/projects/todou/issues/3", () => issueWith({})],
    ]);
    const result = await runCli(
      ["issue", "edit", "3", "--labels", "bug,chore"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("treats the singular --label the same way", async () => {
    const store = labelStore([bug, chore]);
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ...store.routes,
      ["GET", "/api/projects/todou/issues/3", issueWith({ labels: [bug] })],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({});
        },
      ],
    ]);
    const result = await runCli(["issue", "edit", "3", "--label", "chore"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ label_ids: [8] });
    expect(result.stderr).toContain("removed bug");
  });

  it("creates unknown names while replacing", async () => {
    const store = labelStore([bug]);
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ...store.routes,
      ["GET", "/api/projects/todou/issues/3", issueWith({ labels: [bug] })],
      [
        "PATCH",
        "/api/projects/todou/issues/3",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return issueWith({});
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "edit", "3", "--labels", "area:infra"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(store.created).toHaveLength(1);
    expect(patched).toEqual({ label_ids: [8] });
  });

  it("refuses to mix replacing with adding", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(
      ["issue", "edit", "3", "--labels", "a", "--add-label", "b"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("replaces the whole label set");
    expect(result.stderr).toContain("pass one style or the other");
  });
});

describe("gh-shaped flags (T-135)", () => {
  it("takes gh's short flags on issue create", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/labels", [bug, chore]],
      ["GET", "/api/me", me],
      [
        "POST",
        "/api/projects/todou/issues",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return issueWith({ number: 9, title: "New one" });
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "create",
        "-t",
        "New one",
        "-b",
        "hello",
        "-l",
        "bug,chore",
        "-a",
        "@me",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({
      title: "New one",
      body: "hello",
      status_id: undefined,
      label_ids: [7, 8],
      assignee_ids: [2],
    });
  });

  it("maps --state onto the category param", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
    ]);
    for (const [state, expected] of [
      ["open", "open"],
      ["closed", "closed"],
      ["all", null],
    ] as const) {
      calls.length = 0;
      const result = await runCli(["issue", "list", "-s", state], {
        fetchImpl,
        env: loggedInEnv("todou"),
      });
      expect(result.exitCode).toBe(0);
      const url = new URL(calls[0]?.url ?? "", "http://stub.test");
      expect(url.searchParams.get("category")).toBe(expected);
    }
  });

  it("keeps -S/--search apart from -s/--state", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
    ]);
    const result = await runCli(["issue", "list", "-S", "potato", "-L", "5"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const url = new URL(calls[0]?.url ?? "", "http://stub.test");
    expect(url.searchParams.get("q")).toBe("potato");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("category")).toBe(null);
  });

  it("rejects --state alongside the flags it duplicates", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "list", "-s", "open", "--closed"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });

  it("comma-splits a label filter into several ids", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/labels", [bug, chore]],
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
    ]);
    const result = await runCli(["issue", "list", "-l", "bug,chore"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const listCall = calls.find((c) => c.url.includes("/issues?"));
    const url = new URL(listCall?.url ?? "", "http://stub.test");
    expect(url.searchParams.get("label")).toBe("7,8");
  });
});

describe("label create/delete, gh shapes", () => {
  it("takes the name as a positional and derives a color", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/labels",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return { id: 9, name: "area:cli", color: posted.color };
        },
      ],
    ]);
    const result = await runCli(["label", "create", "area:cli"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({
      name: "area:cli",
      color: labelColorFor("area:cli"),
    });
    expect(result.stderr).toContain(
      "recolor: todou label edit 'area:cli' -p todou --color '#rrggbb'",
    );
  });

  it("takes a bare hex color, and stays quiet when one was given", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/labels",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return { id: 9, name: "urgent", color: "#ff0000" };
        },
      ],
    ]);
    const result = await runCli(
      ["label", "create", "urgent", "--color", "f00"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({ name: "urgent", color: "#ff0000" });
    expect(result.stderr).toBe("");
  });

  it("refuses a positional and a --name that disagree", async () => {
    const { fetchImpl } = fakeFetch([]);
    const clash = await runCli(["label", "create", "one", "--name", "other"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(clash.exitCode).toBe(1);
    expect(clash.stderr).toContain("they must agree");

    const missing = await runCli(["label", "create"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("no label name");
  });

  it("accepts gh's --yes on delete", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/labels", [chore]],
      ["DELETE", "/api/projects/todou/labels/8", { __status: 204 }],
    ]);
    const result = await runCli(["label", "delete", "chore", "--yes"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("deleted label chore");
  });
});
