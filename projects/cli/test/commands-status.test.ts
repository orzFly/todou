import { describe, expect, it } from "vitest";
import type { Route } from "./harness.ts";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

// The seed every new project gets (contiguous positions, no default).
const seeded = [
  {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: false,
  },
  {
    id: 2,
    name: "In Progress",
    category: "open",
    color: "#3b82f6",
    position: 1,
    is_default: false,
  },
  {
    id: 3,
    name: "Done",
    category: "closed",
    color: "#22c55e",
    position: 2,
    is_default: false,
  },
];

/** What a project seeded by today's server looks like, ids 1..7 in order. */
function canonicalBoard() {
  return [
    ["Backlog", "open", "#9ca3af"],
    ["Todo", "open", "#6b7280"],
    ["Next", "open", "#06b6d4"],
    ["In Progress", "open", "#3b82f6"],
    ["Ready to Ship", "open", "#f59e0b"],
    ["Shipped", "open", "#8b5cf6"],
    ["Done", "closed", "#22c55e"],
  ].map(([name, category, color], i) => ({
    id: i + 1,
    name,
    category,
    color,
    position: i,
    is_default: name === "Todo",
  }));
}

function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("status create", () => {
  it("posts the input as-is when no placement is asked for", async () => {
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/statuses",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return {
            id: 9,
            name: "Blocked",
            category: "open",
            color: "#ff0000",
            position: 3,
            is_default: false,
          };
        },
      ],
    ]);
    const result = await runCli(
      [
        "status",
        "create",
        "--name",
        "Blocked",
        "--category",
        "open",
        "--color",
        "#ff0000",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({
      name: "Blocked",
      category: "open",
      color: "#ff0000",
    });
    // The status list is only fetched when --before/--after needs it.
    expect(calls).toHaveLength(1);
    expect(result.stdout).toBe(
      "created status Blocked (open, #ff0000) at position 3\n",
    );
  });

  it("--before claims the anchor's slot and shifts the run after it", async () => {
    let posted: Record<string, unknown> | undefined;
    const patched: Array<{ id: string; body: Record<string, unknown> }> = [];
    const patchRoute = (id: number) =>
      [
        "PATCH",
        `/api/projects/todou/statuses/${id}`,
        (init: RequestInit) => {
          patched.push({ id: String(id), body: jsonBody(init) });
          return { ...seeded[id - 1], ...jsonBody(init) };
        },
      ] as const;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", seeded],
      [
        "POST",
        "/api/projects/todou/statuses",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return {
            id: 9,
            name: "Next",
            category: "open",
            color: "#6b7280",
            position: 1,
            is_default: false,
          };
        },
      ],
      [...patchRoute(2)],
      [...patchRoute(3)],
    ]);
    const result = await runCli(
      [
        "status",
        "create",
        "--name",
        "Next",
        "--category",
        "open",
        "--before",
        "in progress",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({ name: "Next", category: "open", position: 1 });
    expect(patched).toEqual([
      { id: "2", body: { position: 2 } },
      { id: "3", body: { position: 3 } },
    ]);
    // The new row exists before anything moves: create, then shift.
    expect(calls.map((c) => c.init.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "PATCH",
      "PATCH",
    ]);
    expect(result.stderr).toContain("made room by moving In Progress, Done");
  });

  it("--after slips into an existing position gap without shifting", async () => {
    const gappy = [
      { ...seeded[0], position: 0 },
      { ...seeded[1], position: 10 },
      { ...seeded[2], position: 20 },
    ];
    let posted: Record<string, unknown> | undefined;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", gappy],
      [
        "POST",
        "/api/projects/todou/statuses",
        (init: RequestInit) => {
          posted = jsonBody(init);
          return {
            id: 9,
            name: "Next",
            category: "open",
            color: "#6b7280",
            position: 1,
            is_default: false,
          };
        },
      ],
    ]);
    const result = await runCli(
      [
        "status",
        "create",
        "--name",
        "Next",
        "--category",
        "open",
        "--after",
        "Todo",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual({ name: "Next", category: "open", position: 1 });
    expect(calls.filter((c) => c.init.method === "PATCH")).toHaveLength(0);
  });

  it("rejects --before together with --after, before any request", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const result = await runCli(
      [
        "status",
        "create",
        "--name",
        "X",
        "--category",
        "open",
        "--before",
        "Todo",
        "--after",
        "Done",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid --category before any request", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const result = await runCli(
      ["status", "create", "--name", "X", "--category", "sideways"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid category "sideways"');
    expect(calls).toHaveLength(0);
  });

  it("names the available statuses when the anchor is unknown", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", seeded],
    ]);
    const result = await runCli(
      [
        "status",
        "create",
        "--name",
        "X",
        "--category",
        "open",
        "--before",
        "Nope",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown status "Nope"');
    expect(result.stderr).toContain("Todo, In Progress, Done");
  });
});

describe("status edit", () => {
  it("patches only the given fields on the resolved id", async () => {
    let patched: Record<string, unknown> | undefined;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", seeded],
      [
        "PATCH",
        "/api/projects/todou/statuses/1",
        (init: RequestInit) => {
          patched = jsonBody(init);
          return { ...seeded[0], name: "Later", color: "#111111" };
        },
      ],
    ]);
    const result = await runCli(
      ["status", "edit", "todo", "--name", "Later", "--color", "#111111"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual({ name: "Later", color: "#111111" });
    expect(result.stdout).toBe("updated status Later (open, #111111)\n");
  });

  it("--default and --no-default map onto is_default", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const routes = (reply: Record<string, unknown>) =>
      fakeFetch([
        ["GET", "/api/projects/todou/statuses", seeded],
        [
          "PATCH",
          "/api/projects/todou/statuses/1",
          (init: RequestInit) => {
            bodies.push(jsonBody(init));
            return { ...seeded[0], ...reply };
          },
        ],
      ]);
    const on = await runCli(["status", "edit", "Todo", "--default"], {
      fetchImpl: routes({ is_default: true }).fetchImpl,
      env: loggedInEnv("todou"),
    });
    const off = await runCli(["status", "edit", "Todo", "--no-default"], {
      fetchImpl: routes({ is_default: false }).fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(on.exitCode).toBe(0);
    expect(off.exitCode).toBe(0);
    expect(bodies).toEqual([{ is_default: true }, { is_default: false }]);
    expect(on.stdout).toContain("— default");
  });

  it("--after moves the status and shifts what follows", async () => {
    const patched: Array<{ id: string; body: Record<string, unknown> }> = [];
    const patchRoute = (id: number) =>
      [
        "PATCH",
        `/api/projects/todou/statuses/${id}`,
        (init: RequestInit) => {
          patched.push({ id: String(id), body: jsonBody(init) });
          return { ...seeded[id - 1], ...jsonBody(init) };
        },
      ] as const;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", seeded],
      [...patchRoute(1)],
      [...patchRoute(3)],
    ]);
    const result = await runCli(
      ["status", "edit", "Todo", "--after", "In Progress"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    // Todo takes position 2 (after In Progress at 1); Done gives way to 3.
    expect(patched).toEqual([
      { id: "1", body: { position: 2 } },
      { id: "3", body: { position: 3 } },
    ]);
  });

  it("refuses to anchor a status to itself", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", seeded],
    ]);
    const result = await runCli(
      ["status", "edit", "Todo", "--before", "todo"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("relative to itself");
  });

  it("rejects an empty edit without touching the network", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const result = await runCli(["status", "edit", "Todo"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nothing to change");
    expect(calls).toHaveLength(0);
  });
});

describe("status delete", () => {
  it("deletes by resolved id and keeps stdout clean", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", seeded],
      ["DELETE", "/api/projects/todou/statuses/3", { __status: 204 }],
    ]);
    const result = await runCli(["status", "delete", "done"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("deleted status Done");
    expect(calls.at(-1)?.init.method).toBe("DELETE");
  });

  it("turns the 409 for a still-referenced status into a readable error", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", seeded],
      [
        "DELETE",
        "/api/projects/todou/statuses/3",
        {
          __status: 409,
          body: {
            error: {
              code: "conflict",
              message:
                "status is used by existing issues — move them to another status first",
            },
          },
        },
      ],
    ]);
    const result = await runCli(["status", "delete", "Done"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("status is used by existing issues");
    expect(result.stderr).toContain('todou issue list --status "Done"');
  });
});

describe("status init", () => {
  it("fills the canonical gaps in order and pins Todo as the default", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const patched: Array<{ id: string; body: Record<string, unknown> }> = [];
    let nextId = 10;
    const patchRoute = (id: number) =>
      [
        "PATCH",
        `/api/projects/todou/statuses/${id}`,
        (init: RequestInit) => {
          patched.push({ id: String(id), body: jsonBody(init) });
          return { ...seeded[id - 1], ...jsonBody(init) };
        },
      ] as const;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", seeded],
      [
        "POST",
        "/api/projects/todou/statuses",
        (init: RequestInit) => {
          const body = jsonBody(init);
          posted.push(body);
          return { id: nextId++, is_default: false, ...body };
        },
      ],
      [...patchRoute(1)],
      [...patchRoute(2)],
      [...patchRoute(3)],
    ]);
    const result = await runCli(["status", "init"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(posted).toEqual([
      { name: "Backlog", category: "open", color: "#9ca3af", position: 0 },
      { name: "Next", category: "open", color: "#06b6d4", position: 2 },
      {
        name: "Ready to Ship",
        category: "open",
        color: "#f59e0b",
        position: 4,
      },
      { name: "Shipped", category: "open", color: "#8b5cf6", position: 5 },
    ]);
    // The seeded three already carry their canonical colors, so nothing
    // here is a `PATCH { color }` — only position shifts and the default.
    expect(patched).toEqual([
      // Backlog lands at 0: the seeded three give way.
      { id: "1", body: { position: 1 } },
      { id: "2", body: { position: 2 } },
      { id: "3", body: { position: 3 } },
      // Next lands at 2: In Progress and Done give way again.
      { id: "2", body: { position: 3 } },
      { id: "3", body: { position: 4 } },
      // Ready to Ship at 4, Shipped at 5: Done gives way twice.
      { id: "3", body: { position: 5 } },
      { id: "3", body: { position: 6 } },
      // No explicit default existed; Backlog would have hijacked the
      // first-by-position fallback, so Todo gets pinned.
      { id: "1", body: { is_default: true } },
    ]);
    expect(result.stdout).toBe(
      "created Backlog, Next, Ready to Ship, Shipped\nmade Todo the default status\n",
    );
  });

  it("is a no-op when the canonical set already exists", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", canonicalBoard()],
    ]);
    const result = await runCli(["status", "init"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(result.stdout).toBe("all canonical statuses already exist\n");
  });

  it("syncs a drifted color but leaves a drifted category to a human", async () => {
    const drifted = () =>
      canonicalBoard().map((s) =>
        s.name === "Backlog"
          ? { ...s, color: "#6b7280" }
          : s.name === "Done"
            ? { ...s, category: "open" }
            : s,
      );
    // Only Backlog's PATCH route exists: a category PATCH would throw
    // "unexpected fetch" rather than pass unnoticed.
    const routes = (patched: Array<Record<string, unknown>>): Route[] => [
      ["GET", "/api/projects/todou/statuses", drifted()],
      [
        "PATCH",
        "/api/projects/todou/statuses/1",
        (init: RequestInit) => {
          patched.push(jsonBody(init));
          return { ...drifted()[0], ...jsonBody(init) };
        },
      ],
    ];

    const patched: Array<Record<string, unknown>> = [];
    const { fetchImpl } = fakeFetch(routes(patched));
    const result = await runCli(["status", "init"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(patched).toEqual([{ color: "#9ca3af" }]);
    expect(result.stdout).toBe(
      "all canonical statuses already exist\nsynced colors on Backlog\n",
    );
    expect(result.stderr).toContain(
      "Done is open, canonical is closed — left unchanged",
    );

    const jsonPatched: Array<Record<string, unknown>> = [];
    const json = await runCli(["status", "init", "--json"], {
      fetchImpl: fakeFetch(routes(jsonPatched)).fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      created: [],
      recolored: ["Backlog"],
    });
  });
});
