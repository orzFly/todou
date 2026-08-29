import { describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

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
};

const routes = (extra: Parameters<typeof fakeFetch>[0] = []) =>
  fakeFetch([
    ["GET", "/api/projects/todou/issues/3", issue],
    ["GET", "/api/projects/todou/references/config", { __status: 404 }],
    ...extra,
  ]);

describe("issue delete", () => {
  it("refuses to run unprompted off a terminal", async () => {
    const { fetchImpl, calls } = routes();
    const result = await runCli(["issue", "delete", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "refusing to delete without a confirmation",
    );
    expect(result.stderr).toContain("-y");
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });

  it("deletes without prompting under -y", async () => {
    let deleted = false;
    const { fetchImpl } = routes([
      [
        "DELETE",
        "/api/projects/todou/issues/3",
        () => {
          deleted = true;
          return { __status: 204 };
        },
      ],
    ]);
    const result = await runCli(["issue", "delete", "3", "-p", "todou", "-y"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(deleted).toBe(true);
    expect(result.stdout).toContain("#3 deleted");
  });

  it("prompts on a terminal and deletes on y", async () => {
    let deleted = false;
    const { fetchImpl } = routes([
      [
        "DELETE",
        "/api/projects/todou/issues/3",
        () => {
          deleted = true;
          return { __status: 204 };
        },
      ],
    ]);
    const result = await runCli(["issue", "delete", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
      stdinIsTTY: true,
      stdinText: "y\n",
    });
    expect(result.exitCode).toBe(0);
    expect(deleted).toBe(true);
    // The prompt names the card, so a mistyped number is caught here.
    expect(result.stderr).toContain('#3 "Fix the potato"');
  });

  it("cancels on anything else, without touching the server", async () => {
    const { fetchImpl, calls } = routes();
    const result = await runCli(["issue", "delete", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
      stdinIsTTY: true,
      stdinText: "\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cancelled");
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });
});

describe("issue restore", () => {
  it("restores without prompting", async () => {
    const { fetchImpl } = routes([
      ["POST", "/api/projects/todou/issues/3/restore", issue],
    ]);
    const result = await runCli(["issue", "restore", "3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#3 restored (Todo)");
  });
});

describe("issue list --deleted", () => {
  const deleted = {
    ...issue,
    deleted_at: "2026-08-12T09:00:00Z",
    deleted_by: me,
  };

  it("asks the server for the trash and shows the deletion time", async () => {
    let query = "";
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        (_init: RequestInit, url: URL) => {
          query = url.search;
          return { items: [deleted], next_cursor: null };
        },
      ],
      ["GET", "/api/projects/todou/references/config", { __status: 404 }],
    ]);
    const result = await runCli(["issue", "list", "-p", "todou", "--deleted"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(query).toContain("deleted=true");
    expect(result.stdout).toContain("Fix the potato");
  });

  it("says the trash is empty rather than 'no issues'", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
      ["GET", "/api/projects/todou/references/config", { __status: 404 }],
    ]);
    const result = await runCli(["issue", "list", "-p", "todou", "--deleted"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.stdout).toContain("the trash is empty");
  });

  it("leaves the plain list alone", async () => {
    let query = "";
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        (_init: RequestInit, url: URL) => {
          query = url.search;
          return { items: [], next_cursor: null };
        },
      ],
      ["GET", "/api/projects/todou/references/config", { __status: 404 }],
    ]);
    await runCli(["issue", "list", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(query).not.toContain("deleted");
  });
});
